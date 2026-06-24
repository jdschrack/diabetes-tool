FROM node:22-bookworm AS frontend
WORKDIR /app
COPY app/ ./
RUN npm ci
RUN npm run build

FROM python:3.12-slim
WORKDIR /workspace
ENV PYTHONUNBUFFERED=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . ./
COPY --from=frontend /app/dist ./app/dist
EXPOSE 8000
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
