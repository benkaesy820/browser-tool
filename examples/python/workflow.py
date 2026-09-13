"""Independent JSONL client using the Python standard library only.

Drives `bridge serve --stdio`: one request object per stdin line, one
response object per stdout line.

Usage:
    python workflow.py <fixture-file-url>
    BRIDGE_BIN=bridge python workflow.py "file:///path/to/index.html"

NOTE: not yet executed on the maintainer's Windows machine (no Python
installed there); validated by review against the same contract the
Node/PowerShell clients prove live. CI must run it where Python exists.
"""
import json
import os
import subprocess
import sys

BRIDGE_BIN = os.environ.get("BRIDGE_BIN", "bridge")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python workflow.py <fixture-file-url>", file=sys.stderr)
        return 2
    fixture_url = sys.argv[1]

    proc = subprocess.Popen(
        [BRIDGE_BIN, "serve", "--stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    assert proc.stdin is not None and proc.stdout is not None
    child_stdin = proc.stdin
    child_stdout = proc.stdout
    counter = 0

    def call(op: dict) -> dict:
        nonlocal counter
        counter += 1
        request = {"protocolVersion": "1.0", "requestId": f"expy-{counter}", **op}
        child_stdin.write(json.dumps(request) + "\n")
        child_stdin.flush()
        line = child_stdout.readline()
        if not line:
            raise RuntimeError("serve closed stdout early")
        response = json.loads(line)
        if response.get("status") != "completed":
            raise RuntimeError(f"{op['op']} failed: {response.get('code')} {response.get('message')}")
        return response

    def ref(controls: list, pred, what: str) -> str:
        for control in controls:
            if pred(control):
                return str(control["ref"])
        raise RuntimeError(f"control not found: {what}")

    try:
        created = call({"op": "create"})
        session = created["sessionId"]
        opened = call({"op": "open", "sessionId": session, "url": fixture_url})
        field = ref(opened["observation"]["controls"], lambda c: c["role"] == "textbox", "item input")
        filled = call({"op": "fill", "sessionId": session, "ref": field, "text": "apples"})
        add = ref(filled["observation"]["controls"], lambda c: c["name"] == "Add to cart", "add button")
        clicked = call({"op": "click", "sessionId": session, "ref": add})
        if "Item added: apples" not in clicked["observation"]["text"]:
            raise RuntimeError("expected confirmation text missing")
        shot = call({"op": "screenshot", "sessionId": session})
        artifacts = shot.get("artifacts", [])
        if not artifacts or not os.path.exists(artifacts[0]["path"]):
            raise RuntimeError("screenshot artifact missing")
        call({"op": "close", "sessionId": session})
    finally:
        child_stdin.close()
        proc.wait(timeout=30)

    if proc.returncode != 0:
        raise RuntimeError(f"serve exited {proc.returncode}")
    print("PASS: python workflow")
    return 0


if __name__ == "__main__":
    sys.exit(main())
