# Smart Workload Balancing System for Warehouses

A beginner-friendly AI project that simulates warehouse operations and intelligently distributes workload among workers in real-time.

## Project Structure
```text
warehouse_balancer/
│
├── backend/
│   ├── app.py              # Main Flask server and REST API
│   ├── models.py           # Worker models, Balancing AI, and Predictions
│   └── requirements.txt    # Python dependencies
│
├── frontend/
│   ├── index.html          # Dashboard UI
│   ├── style.css           # Styling
│   └── script.js           # API polling and data rendering
│
└── README.md               # Setup Instructions
```

## Setup & Running the Project

### 1. Backend (Python/Flask)
The backend acts as both the AI Simulation loop and the REST API server.

1. Open a terminal and navigate to the `backend` folder:
   ```bash
   cd warehouse_balancer/backend
   ```
2. Install the necessary Python packages:
   ```bash
   pip install -r requirements.txt
   ```
3. Run the Flask server:
   ```bash
   python app.py
   ```
   *You should see output indicating the simulation has started and the server is running on `http://127.0.0.1:5000`.*

### 2. Frontend (HTML/JS/CSS)
The frontend is a static web application that polls the backend every second.

1. Navigate to the `frontend` folder.
2. Double-click the `index.html` file to open it in any modern web browser (Chrome, Edge, Firefox).
3. Alternatively, you can use an extension like VSCode's "Live Server" for auto-reloading.

## How the AI Logic Works
Located in `backend/models.py`.

1. **Worker Simulation:** Every second, workers have a random chance to complete active tasks. As they take on tasks, their `fatigue` level increases. When they are idle, they recover fatigue.
2. **Workload Assigner:** When a new order arrives, the `assign_order` function finds the best worker. It scores each available worker dynamically by looking at their current `workload` and `fatigue` amount, choosing the most optimal worker to prevent overloading one single person.
3. **Prediction Rules:** A simple threshold-based predictor calculates system-wide load and outputs real-time alerts if the system acts like it will cap out soon.
