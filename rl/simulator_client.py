"""
“The simulator is written in JavaScript. 
This Python function starts it through Node and opens a way to send it commands and read its replies.”
"""
# """Start the JavaScript traffic simulator and connect it to Python."""
import json
import subprocess
from pathlib import Path

# Resolve two levels up from this file to locate the project root dynamically
PROJECT_DIR = Path(__file__).resolve().parent.parent
BRIDGE_PATH = PROJECT_DIR / "scripts" / "simulator-bridge.cjs"

def start_simulator():
    # Popen runs Node asynchronously in the background (unlike subprocess.run)
    return subprocess.Popen(
        ["node" , str(BRIDGE_PATH)],
        # Run from project root so Node resolves relative paths and node_modules properly
        cwd = PROJECT_DIR,
        stdin = subprocess.PIPE,
        stdout = subprocess.PIPE,
        # Handle pipe I/O as UTF-8 strings instead of raw bytes
        encoding="utf-8",

    )

class SimulatorClient:
    """Keep one simulator process alive across multiple requests."""

    def __init__(self):
        self._process = start_simulator()

    def request(self, command: dict) -> dict:
        """Send one command and return the simulator's reply."""
        process = self._process
        if process.poll() is not None:
            raise RuntimeError("The simulator process has already exited.")

        stdin = process.stdin
        stdout = process.stdout
        assert stdin is not None and stdout is not None

        # The bridge reads one JSON object per line.
        message = json.dumps(command, allow_nan=False)
        try:
            stdin.write(message + "\n")
            stdin.flush()
        except BrokenPipeError as error:
            raise RuntimeError("The simulator closed its input.") from error

        reply = stdout.readline()
        if not reply:
            raise RuntimeError("The simulator exited before sending a reply.")

        response = json.loads(reply)
        if not isinstance(response, dict):
            raise RuntimeError("Expected a JSON object from the simulator.")
        return response

    def close(self) -> None:
        """Close the simulator's input and wait for Node to exit."""
        process = self._process
        if process.stdin is not None and process.stdin.closed:
            return

        try:
            process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()