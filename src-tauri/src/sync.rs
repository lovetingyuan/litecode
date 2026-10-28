use std::sync::{LockResult, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

// Poisoning is advisory: preserve buffers after a failed task instead of making
// every later command panic. Callers must still validate their normal invariants.
fn recover<T>(result: LockResult<T>) -> T {
    result.unwrap_or_else(|error| error.into_inner())
}

pub trait MutexExt<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        recover(self.lock())
    }
}

pub trait RwLockExt<T> {
    fn read_recover(&self) -> RwLockReadGuard<'_, T>;
    fn write_recover(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwLockExt<T> for RwLock<T> {
    fn read_recover(&self) -> RwLockReadGuard<'_, T> {
        recover(self.read())
    }
    fn write_recover(&self) -> RwLockWriteGuard<'_, T> {
        recover(self.write())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poisoned_state_can_still_be_read_and_updated() {
        let state = Mutex::new(vec!["unsaved"]);
        let _ = std::panic::catch_unwind(|| {
            let _guard = state.lock_recover();
            panic!("one task failed");
        });
        assert!(state.is_poisoned());
        state.lock_recover().push("recovered");
        assert_eq!(*state.lock_recover(), ["unsaved", "recovered"]);
    }
}
