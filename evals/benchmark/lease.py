"""Process-held ownership of a run directory before roots or sidecars change."""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path


class LeaseError(ValueError):
    pass


@contextmanager
def acquire(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(out / ".run.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise LeaseError("another process owns this benchmark run directory") from error
        yield
    finally:
        # Keep the inode: unlinking a lock file lets another process lock a
        # different inode while a waiter still refers to this one.
        os.close(descriptor)
