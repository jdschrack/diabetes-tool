import type { DashboardData } from "./types";

export async function fetchDashboard(): Promise<DashboardData> {
  const response = await fetch("/api/dashboard");
  if (!response.ok) {
    throw new Error(`Dashboard request failed: ${response.status}`);
  }
  return response.json();
}

export async function importTidepoolExport(file: File): Promise<DashboardData> {
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
  return payload.dashboard;
}
