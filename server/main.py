from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "analysis" / "tidepool.db"
DASHBOARD_DATA_PATH = ROOT / "dashboard" / "dashboard-data.js"
IMPORT_DIR = ROOT / "data" / "imports"
STATIC_DIR = ROOT / "app" / "dist"
IMPORT_JOBS: dict[str, dict[str, Any]] = {}
IMPORT_JOBS_LOCK = threading.Lock()

app = FastAPI(title="Tidepool Dashboard")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run_script(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def run_script_or_raise(args: list[str]) -> None:
    result = subprocess.run(
        [sys.executable, *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise HTTPException(
            status_code=500,
            detail={
                "command": " ".join([sys.executable, *args]),
                "stdout": result.stdout,
                "stderr": result.stderr,
            },
        )


def read_dashboard_payload() -> dict[str, Any]:
    if not DASHBOARD_DATA_PATH.exists():
        run_script_or_raise(["scripts/build_dashboard_data.py"])
    text = DASHBOARD_DATA_PATH.read_text(encoding="utf-8")
    prefix = "window.DASHBOARD_DATA = "
    if not text.startswith(prefix):
        raise HTTPException(status_code=500, detail="dashboard-data.js has unexpected format")
    return json.loads(text.removeprefix(prefix).rstrip(";\n"))


def create_import_job(filename: str, source: str = "tidepool") -> dict[str, Any]:
    job_id = str(uuid.uuid4())
    import_label = "Import Tidepool records" if source == "tidepool" else "Import Cronometer nutrition"
    job = {
        "id": job_id,
        "filename": filename,
        "source": source,
        "status": "queued",
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "message": "Import queued",
        "steps": [
            {"key": "upload", "label": "Save uploaded export", "status": "completed", "message": "Upload saved"},
            {"key": "import", "label": import_label, "status": "pending", "message": ""},
            {"key": "build", "label": "Rebuild dashboard data", "status": "pending", "message": ""},
            {"key": "reload", "label": "Reload dashboard", "status": "pending", "message": ""},
        ],
        "stdout": "",
        "stderr": "",
        "summary": None,
    }
    with IMPORT_JOBS_LOCK:
        IMPORT_JOBS[job_id] = job
    return job


def get_import_job(job_id: str) -> dict[str, Any]:
    with IMPORT_JOBS_LOCK:
        job = IMPORT_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Import job not found")
        return json.loads(json.dumps(job))


def update_import_job(job_id: str, **updates: Any) -> None:
    with IMPORT_JOBS_LOCK:
        job = IMPORT_JOBS[job_id]
        job.update(updates)
        job["updated_at"] = utc_now()


def update_import_step(job_id: str, step_key: str, status: str, message: str = "") -> None:
    with IMPORT_JOBS_LOCK:
        job = IMPORT_JOBS[job_id]
        for step in job["steps"]:
            if step["key"] == step_key:
                step["status"] = status
                step["message"] = message
                break
        job["updated_at"] = utc_now()


def fail_import_job(job_id: str, step_key: str, result: subprocess.CompletedProcess[str]) -> None:
    update_import_step(job_id, step_key, "failed", f"Command failed with exit code {result.returncode}")
    update_import_job(
        job_id,
        status="failed",
        message=f"Import failed during {step_key}",
        stdout=result.stdout[-8000:],
        stderr=result.stderr[-8000:],
    )


def run_import_job(job_id: str, destination: Path) -> None:
    update_import_job(job_id, status="running", message="Importing Tidepool records")
    update_import_step(job_id, "import", "running", "Running Tidepool SQLite import")
    result = run_script(["scripts/import_tidepool.py", str(destination), "--append"])
    if result.returncode:
        fail_import_job(job_id, "import", result)
        return
    update_import_step(job_id, "import", "completed", "Tidepool records imported")

    update_import_job(job_id, message="Rebuilding dashboard data")
    update_import_step(job_id, "build", "running", "Running dashboard data builder")
    result = run_script(["scripts/build_dashboard_data.py"])
    if result.returncode:
        fail_import_job(job_id, "build", result)
        return
    update_import_step(job_id, "build", "completed", "Dashboard data rebuilt")

    update_import_job(job_id, message="Reloading dashboard payload")
    update_import_step(job_id, "reload", "running", "Reading generated dashboard data")
    try:
        payload = read_dashboard_payload()
    except Exception as exc:  # noqa: BLE001 - capture job failure for display.
        update_import_step(job_id, "reload", "failed", str(exc))
        update_import_job(job_id, status="failed", message="Dashboard reload failed", stderr=str(exc))
        return

    update_import_step(job_id, "reload", "completed", "Dashboard payload ready")
    update_import_job(
        job_id,
        status="completed",
        message="Import completed",
        summary={
            "days": len(payload["tidepool"]["daily_ranges"]),
            "readings": payload["tidepool"]["totals"]["readings"],
            "latest_day": payload["tidepool"]["daily_ranges"][-1]["day"] if payload["tidepool"]["daily_ranges"] else None,
        },
    )


def parse_json_stdout(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}


def run_cronometer_import_job(job_id: str, destination: Path) -> None:
    update_import_job(job_id, status="running", message="Importing Cronometer nutrition")
    update_import_step(job_id, "import", "running", "Checking duplicates and storing nutrition rows")
    import_result = run_script(["scripts/import_cronometer.py", str(destination)])
    if import_result.returncode:
        fail_import_job(job_id, "import", import_result)
        return
    import_summary = parse_json_stdout(import_result)
    update_import_step(
        job_id,
        "import",
        "completed",
        f"{import_summary.get('imported', 0)} imported · {import_summary.get('duplicates', 0)} duplicates skipped",
    )

    update_import_job(job_id, message="Rebuilding dashboard data")
    update_import_step(job_id, "build", "running", "Running dashboard data builder")
    build_result = run_script(["scripts/build_dashboard_data.py"])
    if build_result.returncode:
        fail_import_job(job_id, "build", build_result)
        return
    update_import_step(job_id, "build", "completed", "Dashboard data rebuilt")

    update_import_job(job_id, message="Reloading dashboard payload")
    update_import_step(job_id, "reload", "running", "Reading generated dashboard data")
    try:
        payload = read_dashboard_payload()
    except Exception as exc:  # noqa: BLE001 - capture job failure for display.
        update_import_step(job_id, "reload", "failed", str(exc))
        update_import_job(job_id, status="failed", message="Dashboard reload failed", stderr=str(exc))
        return

    cronometer = payload.get("cronometer", {}).get("totals", {})
    update_import_step(job_id, "reload", "completed", "Dashboard payload ready")
    update_import_job(
        job_id,
        status="completed",
        message="Cronometer import completed",
        stdout=import_result.stdout[-8000:],
        stderr=import_result.stderr[-8000:],
        summary={
            "days": cronometer.get("days", import_summary.get("days", 0)),
            "readings": cronometer.get("rows", import_summary.get("total_rows", 0)),
            "latest_day": cronometer.get("latest_day", import_summary.get("latest_day")),
            "imported": import_summary.get("imported", 0),
            "duplicates": import_summary.get("duplicates", 0),
            "total_rows": import_summary.get("total_rows", cronometer.get("rows", 0)),
        },
    )


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "database": DB_PATH.exists()}


@app.get("/api/dashboard")
def dashboard() -> dict[str, Any]:
    return read_dashboard_payload()


@app.post("/api/import")
async def import_tidepool(background_tasks: BackgroundTasks, file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Upload a Tidepool JSON export")

    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    destination = IMPORT_DIR / Path(file.filename).name
    with destination.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    job = create_import_job(destination.name, "tidepool")
    background_tasks.add_task(run_import_job, job["id"], destination)
    return {"job": get_import_job(job["id"])}


@app.post("/api/import/cronometer")
async def import_cronometer(background_tasks: BackgroundTasks, file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Upload a Cronometer CSV export")

    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    destination = IMPORT_DIR / Path(file.filename).name
    with destination.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    job = create_import_job(destination.name, "cronometer")
    background_tasks.add_task(run_cronometer_import_job, job["id"], destination)
    return {"job": get_import_job(job["id"])}


@app.get("/api/import/{job_id}")
def import_status(job_id: str) -> dict[str, Any]:
    return {"job": get_import_job(job_id)}


if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")


@app.get("/{path:path}")
def spa(path: str) -> FileResponse:
    index = STATIC_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="Frontend has not been built")
    return FileResponse(index)
