"""Fresh-process pipeline rehearsal with SDK, credentials and Python network forbidden.

Installation is separate. Explicit local say/Node/Chromium/ffmpeg subprocesses are
allowed; the renderer restricts requests to its ephemeral exact-file loopback list.
"""
from pathlib import Path
import runpy

guard = runpy.run_path(str(Path(__file__).resolve().parents[1]/'avatar/offline.py'))['guard']
_, empty = guard()
try:
    import run_pipeline
    raise SystemExit(run_pipeline.main())
finally:
    empty.cleanup()
