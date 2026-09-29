"""
Long-running MarkItDown worker for the Node reader (see client.js).

The earlier integration (AMI-Markdown-Feature) spawned a fresh Python
process per file and passed it a path on disk. That costs a Python start
plus a MarkItDown import on every file, and it needs the file written to
disk first. This worker is started once and kept alive, and file bytes
come in over stdin, so nothing touches the disk.

Protocol, one request at a time:

    request:  one JSON line  {"id": 1, "name": "deck.pptx", "size": 12345, "max_chars": 200000}
              then exactly `size` raw bytes
    response: one JSON line  {"id": 1, "success": true, "markdown": "...", ...}

On startup the worker writes one line: {"ready": true, "version": ..., "extensions": [...]}.
stdout carries protocol lines only; anything else goes to stderr.

Conversion rules (supported list, NaN-cell cleanup, never raising) carry
over from the converter in AMI-Markdown-Feature.
"""

import io
import json
import logging
import re
import sys
import time
from pathlib import Path

logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
log = logging.getLogger("ami.markitdown.worker")

SUPPORTED_EXTENSIONS = {
    ".docx", ".pptx", ".xlsx", ".xls",
    ".csv", ".html", ".htm", ".json", ".xml", ".txt", ".md",
}

OFFICE_ZIP_EXTENSIONS = {".docx", ".pptx", ".xlsx"}

# pandas renders empty spreadsheet cells as the literal string "NaN",
# which reads like real data in a table. Blank exactly those cells.
_NAN_CELL = re.compile(r"\|\s*NaN\s*(?=\|)")

# Keep the real stdout for protocol lines and point sys.stdout at stderr,
# so a stray print() inside a converter can't corrupt the stream.
PROTOCOL_OUT = sys.stdout.buffer
sys.stdout = sys.stderr


def send(obj):
    PROTOCOL_OUT.write(json.dumps(obj).encode("utf-8") + b"\n")
    PROTOCOL_OUT.flush()


def read_exact(stream, size):
    chunks, remaining = [], size
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("stdin closed mid-request")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def convert(engine, stream_info_cls, name, data, max_chars):
    ext = Path(name).suffix.lower()
    base = {"filename": name, "extension": ext, "markdown": None, "error": None,
            "char_count": 0, "truncated": False, "warnings": []}
    if ext not in SUPPORTED_EXTENSIONS:
        return {**base, "success": False, "error": f"'{ext}' isn't in the supported list"}

    # MarkItDown quietly falls back to its plain-text converter when the
    # real one can't parse a file, so a corrupt .docx comes back as
    # "success" with garbage in it. Office files are ZIPs; check that
    # much before trusting the result.
    if ext in OFFICE_ZIP_EXTENSIONS and not data.startswith(b"PK"):
        return {**base, "success": False, "error": f"not a valid {ext} file (no ZIP header)"}

    started = time.monotonic()
    try:
        result = engine.convert_stream(
            io.BytesIO(data), stream_info=stream_info_cls(extension=ext, filename=name)
        )
        text = (result.text_content or "").strip()
        if ext in (".xlsx", ".xls"):
            text = _NAN_CELL.sub("|  ", text)
        duration_ms = int((time.monotonic() - started) * 1000)
        if not text:
            return {**base, "success": False, "duration_ms": duration_ms,
                    "error": "no text produced - file may be image-only, password-protected or empty"}

        truncated = len(text) > max_chars
        if truncated:
            text = text[:max_chars]
            base["warnings"].append(f"Truncated to {max_chars} characters.")
        return {**base, "success": True, "markdown": text, "char_count": len(text),
                "truncated": truncated, "duration_ms": duration_ms}
    except Exception as exc:  # a bad file must never take the worker down
        log.warning("conversion failed for %s: %s", name, exc)
        return {**base, "success": False, "error": f"{type(exc).__name__}: {exc}",
                "duration_ms": int((time.monotonic() - started) * 1000)}


def main():
    try:
        import markitdown
        from markitdown import MarkItDown, StreamInfo
    except Exception as exc:
        send({"ready": False, "error": f"markitdown not importable: {exc}"})
        return 1

    # Plugins off: a third-party plugin shouldn't run inside AMI just
    # because someone pip-installed it.
    engine = MarkItDown(enable_plugins=False)
    send({"ready": True, "version": getattr(markitdown, "__version__", "unknown"),
          "extensions": sorted(SUPPORTED_EXTENSIONS)})

    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline()
        if not line:
            return 0  # parent closed stdin: normal shutdown
        try:
            header = json.loads(line)
            data = read_exact(stdin, int(header["size"]))
        except EOFError:
            return 0
        except Exception as exc:
            # The stream is out of sync; nothing sensible left to read.
            send({"id": None, "success": False, "error": f"bad request header: {exc}"})
            return 1

        response = convert(engine, StreamInfo, header.get("name", "file"), data,
                           int(header.get("max_chars") or 200_000))
        del data
        send({"id": header.get("id"), **response})


if __name__ == "__main__":
    sys.exit(main())
