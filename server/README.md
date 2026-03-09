# Server

## How to Use

Before launching the server, make sure you have Python (>= 3.12) and [uv](https://docs.astral.sh/uv/) installed.

1. Install dependencies:
```bash
uv sync
```

2. Build the python runner image in `./docker`:
```bash
docker build -f docker/PythonRunnerDockerfile -t python-runner .
```

3. Create a `./.env` config file according to fields described in `./.env.example`. 

4. Run the server:
```bash
uv run uvicorn main:app --reload
```
