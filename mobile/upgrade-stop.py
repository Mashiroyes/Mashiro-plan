"""One-time safe upgrade preparation; never reset play/cooldown state."""
from pathlib import Path
import fcntl,sys,time
sys.path.insert(0,'/data/local/plan-qq-guard')
from guard import Store
from android import Android
root=Path('/data/local/plan-qq-guard');store=Store(root);android=Android(root)
while True:
    with store.locked():
        state=store.load()
        if state['phase'] != 'playing':
            android.block()
            (root/'stop').write_text('Temporary upgrade pause\n')
            print('UPGRADE_PAUSED_WITH_STATE_PRESERVED',flush=True)
            break
    print('WAITING_FOR_ACTIVE_PLAY_TO_END',flush=True)
    time.sleep(10)
with (root/'supervisor.lock').open('a') as lock:
    deadline=time.monotonic()+60
    while True:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                (root/'stop').unlink(missing_ok=True)
                raise RuntimeError('Supervisor did not stop; upgrade cancelled')
            time.sleep(1)
print('UPGRADE_READY',flush=True)
