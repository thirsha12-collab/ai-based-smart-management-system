# Use lightweight Python 3.10 wrapper
FROM python:3.10-slim

# Create root runtime directory
WORKDIR /app

# Copy Requirements and cache
COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements.txt

# Sync application source code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Establish execution point
WORKDIR /app/backend

# Inform docker of WSGI Eventlet Socket Port mapping
EXPOSE 5000

# Command to natively run the Websocket Flask setup
CMD ["python", "app.py"]
