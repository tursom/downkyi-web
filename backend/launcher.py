"""Terminate the complete worker group if its supervising server disappears."""
import ctypes
import os
import runpy
import signal
import subprocess
import sys


def terminate_group(signum, _frame):
    # A dead supervisor cannot escalate later; stop even TERM-resistant descendants.
    os.killpg(os.getpgrp(), signal.SIGKILL)
    raise SystemExit(128 + signum)


def main():
    parent = int(sys.argv.pop(1))
    module = sys.argv.pop(1)
    lock_fd = os.environ.get("DOWNKYI_TASK_LOCK_FD")
    if lock_fd is not None:
        fd = int(lock_fd)
        os.fstat(fd)
        original_popen = subprocess.Popen

        class LockedPopen(original_popen):
            def __init__(self, *args, **kwargs):
                # Preserve the task lock in FFmpeg, not just its Python parent.
                kwargs["pass_fds"] = tuple(set(kwargs.get("pass_fds", ())) | {fd})
                kwargs["close_fds"] = True
                super().__init__(*args, **kwargs)

        subprocess.Popen = LockedPopen
    if sys.platform == "linux":
        signal.signal(signal.SIGTERM, terminate_group)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
            raise RuntimeError("Cannot configure worker parent-death signal")
        if os.getppid() != parent:
            terminate_group(signal.SIGTERM, None)
    sys.argv[0] = module
    runpy.run_module(module, run_name="__main__")


if __name__ == "__main__":
    main()
