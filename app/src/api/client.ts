import type { DashboardData, ImportJob } from "./types";

export async function fetchDashboard(): Promise<DashboardData> {
  const response = await fetch("/api/dashboard");
  if (!response.ok) {
    throw new Error(`Dashboard request failed: ${response.status}`);
  }
  return response.json();
}

export async function startTidepoolImport(file: File): Promise<ImportJob> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/import", {
    method: "POST",
    body: form
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Import failed: ${message}`);
  }
  const payload = await response.json();
  return payload.job;
}

export async function startCronometerImport(file: File): Promise<ImportJob> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/import/cronometer", {
    method: "POST",
    body: form
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Cronometer import failed: ${message}`);
  }
  const payload = await response.json();
  return payload.job;
}

export async function fetchImportJob(id: string): Promise<ImportJob> {
  const response = await fetch(`/api/import/${id}`);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Import status failed: ${message}`);
  }
  const payload = await response.json();
  return payload.job;
}
