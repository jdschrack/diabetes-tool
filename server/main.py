from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "analysis" / "tidepool.db"
DASHBOARD_DATA_PATH = ROOT / "dashboard" / "dashboard-data.js"
IMPORT_DIR = ROOT / "data" / "imports"
STATIC_DIR = ROOT / "app" / "dist"

app = FastAPI(title="Tidepool Dashboard")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def run_script(args: list[str]) -> None:
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
        run_script(["scripts/build_dashboard_data.py"])
    text = DASHBOARD_DATA_PATH.read_text(encoding="utf-8")
    prefix = "window.DASHBOARD_DATA = "
    if not text.startswith(prefix):
        raise HTTPException(status_code=500, detail="dashboard-data.js has unexpected format")
    return json.loads(text.removeprefix(prefix).rstrip(";\n"))


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "database": DB_PATH.exists()}


@app.get("/api/dashboard")
def dashboard() -> dict[str, Any]:
    return read_dashboard_payload()


@app.post("/api/import")
async def import_tidepool(file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Upload a Tidepool JSON export")

    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    destination = IMPORT_DIR / Path(file.filename).name
    with destination.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    run_script(["scripts/import_tidepool.py", str(destination), "--append"])
    run_script(["scripts/build_dashboard_data.py"])
    return {"imported": destination.name, "dashboard": read_dashboard_payload()}


if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")


@app.get("/{path:path}")
def spa(path: str) -> FileResponse:
    index = STATIC_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="Frontend has not been built")
    return FileResponse(index)
