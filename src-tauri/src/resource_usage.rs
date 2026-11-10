use crate::error::{AppError, Result};
#[cfg(windows)]
use crate::sync::MutexExt;
use serde::Serialize;
#[cfg(any(windows, test))]
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
#[cfg(windows)]
use std::{collections::HashSet, sync::Mutex};
#[cfg(windows)]
use tauri::Manager;
use tauri::{State, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    memory_bytes: u64,
    cpu_percent: Option<f64>,
}

#[cfg(any(windows, test))]
struct ProcessSample {
    // Creation time distinguishes a new process that reuses an old PID.
    created: u64,
    cpu_ticks: u64,
    memory_bytes: u64,
}

#[cfg(any(windows, test))]
struct Sample {
    at: Instant,
    processes: HashMap<u32, ProcessSample>,
}

#[cfg(any(windows, test))]
impl Sample {
    fn usage(&self, previous: Option<&Self>, processors: u32) -> ResourceUsage {
        let cpu_percent = previous.and_then(|previous| {
            let elapsed = self.at.checked_duration_since(previous.at)?;
            if elapsed.is_zero() || elapsed > Duration::from_secs(3) || processors == 0 {
                return None;
            }
            // A changed process set needs a fresh baseline rather than reporting
            // a partial total, or charging a reused PID's lifetime CPU time.
            if self.processes.len() != previous.processes.len() {
                return None;
            }
            let ticks = self.processes.iter().try_fold(0u64, |total, (pid, now)| {
                let before = previous.processes.get(pid)?;
                if now.created != before.created {
                    return None;
                }
                total.checked_add(now.cpu_ticks.checked_sub(before.cpu_ticks)?)
            })?;
            Some(
                (ticks as f64 / 10_000_000.0 / elapsed.as_secs_f64() / processors as f64 * 100.0)
                    .clamp(0.0, 100.0),
            )
        });
        ResourceUsage {
            memory_bytes: self.processes.values().map(|p| p.memory_bytes).sum(),
            cpu_percent,
        }
    }
}

#[derive(Default)]
pub struct ResourceMonitor {
    #[cfg(windows)]
    samples: Mutex<HashMap<String, Sample>>,
}

impl ResourceMonitor {
    pub fn close_window(&self, label: &str) {
        #[cfg(windows)]
        self.samples.lock_recover().remove(label);
        #[cfg(not(windows))]
        let _ = label;
    }
}

#[cfg(windows)]
async fn webview_processes(app: &tauri::AppHandle) -> Result<HashSet<u32>> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment8;
    use windows::core::Interface;

    let mut processes = HashSet::from([std::process::id()]);
    for window in app.webview_windows().into_values() {
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                // SAFETY: WebView2 COM interfaces are accessed only on their UI
                // thread. Only plain PIDs leave this callback.
                let result = unsafe {
                    (|| -> windows::core::Result<Vec<u32>> {
                        let environment =
                            webview.environment().cast::<ICoreWebView2Environment8>()?;
                        let collection = environment.GetProcessInfos()?;
                        let mut count = 0;
                        collection.Count(&mut count)?;
                        let mut pids = Vec::new();
                        for index in 0..count {
                            let mut pid = 0;
                            collection.GetValueAtIndex(index)?.ProcessId(&mut pid)?;
                            if pid > 0 {
                                pids.push(pid as u32);
                            }
                        }
                        Ok(pids)
                    })()
                };
                let _ = send.send(
                    result.map_err(|error| AppError::new("resourceUsage", error.to_string())),
                );
            })
            .map_err(|error| AppError::new("resourceUsage", error.to_string()))?;
        let pids = tokio::time::timeout(Duration::from_secs(2), receive)
            .await
            .map_err(|_| AppError::new("resourceUsage", "WebView process query timed out"))?
            .map_err(|_| AppError::new("resourceUsage", "WebView process query was cancelled"))??;
        if pids.is_empty() {
            return Err(AppError::new(
                "resourceUsage",
                "WebView process list is empty",
            ));
        }
        processes.extend(pids);
    }
    Ok(processes)
}

#[cfg(windows)]
fn sample_processes(pids: HashSet<u32>) -> Result<(Sample, u32)> {
    use windows::Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE},
        System::{
            ProcessStatus::{
                GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
                PROCESS_MEMORY_COUNTERS_EX2,
            },
            Threading::{
                ALL_PROCESSOR_GROUPS, GetActiveProcessorCount, GetProcessTimes, OpenProcess,
                PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
            },
        },
    };

    struct ProcessHandle(HANDLE);
    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            // SAFETY: This handle is owned here and is closed exactly once.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    fn ticks(time: FILETIME) -> u64 {
        (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
    }
    let mut processes = HashMap::new();
    for pid in pids {
        // SAFETY: OpenProcess yields an owned handle with query/read rights.
        // All output buffers are initialized and their sizes match the APIs.
        let process = unsafe {
            (|| -> windows::core::Result<ProcessSample> {
                let handle = ProcessHandle(OpenProcess(
                    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                    false,
                    pid,
                )?);
                let mut created = FILETIME::default();
                let mut exited = FILETIME::default();
                let mut kernel = FILETIME::default();
                let mut user = FILETIME::default();
                GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user)?;
                // Private working set excludes shared pages, so summing processes
                // does not double count, and matches Task Manager's Memory column.
                let mut memory = PROCESS_MEMORY_COUNTERS_EX2::default();
                let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
                memory.cb = size;
                // Cast: the API accepts any PROCESS_MEMORY_COUNTERS* variant identified by `cb`.
                let memory_bytes = if GetProcessMemoryInfo(
                    handle.0,
                    (&raw mut memory).cast::<PROCESS_MEMORY_COUNTERS>(),
                    size,
                )
                .is_ok()
                {
                    memory.PrivateWorkingSetSize
                } else {
                    // Windows builds before 21H2 lack EX2; private commit is the closest fallback.
                    let mut memory = PROCESS_MEMORY_COUNTERS_EX::default();
                    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
                    memory.cb = size;
                    GetProcessMemoryInfo(
                        handle.0,
                        (&raw mut memory).cast::<PROCESS_MEMORY_COUNTERS>(),
                        size,
                    )?;
                    memory.PrivateUsage
                };
                Ok(ProcessSample {
                    created: ticks(created),
                    cpu_ticks: ticks(kernel) + ticks(user),
                    memory_bytes: memory_bytes as u64,
                })
            })()
        }
        .map_err(|error| {
            AppError::new(
                "resourceUsage",
                format!("Could not sample process {pid}: {error}"),
            )
        })?;
        processes.insert(pid, process);
    }
    // SAFETY: ALL_PROCESSOR_GROUPS requests the count across all CPU groups.
    let processors = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
    if processors == 0 {
        return Err(AppError::new(
            "resourceUsage",
            "Could not read logical CPU count",
        ));
    }
    Ok((
        Sample {
            at: Instant::now(),
            processes,
        },
        processors,
    ))
}

#[tauri::command]
pub async fn get_app_resource_usage(
    window: WebviewWindow,
    monitor: State<'_, ResourceMonitor>,
    reset: bool,
) -> Result<ResourceUsage> {
    #[cfg(windows)]
    {
        let pids = webview_processes(window.app_handle()).await?;
        let (sample, processors) =
            tauri::async_runtime::spawn_blocking(move || sample_processes(pids))
                .await
                .map_err(|error| AppError::new("resourceUsage", error.to_string()))??;
        let mut samples = monitor.samples.lock_recover();
        let previous = if reset {
            None
        } else {
            samples.get(window.label())
        };
        let usage = sample.usage(previous, processors);
        samples.insert(window.label().to_owned(), sample);
        Ok(usage)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, monitor, reset);
        Err(AppError::new(
            "resourceUsage",
            "Resource usage is only available on Windows",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(at: Instant, processes: &[(u32, u64, u64)]) -> Sample {
        Sample {
            at,
            processes: processes
                .iter()
                .map(|&(pid, created, cpu_ticks)| {
                    (
                        pid,
                        ProcessSample {
                            created,
                            cpu_ticks,
                            memory_bytes: 1024,
                        },
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn first_sample_and_long_pauses_need_a_baseline() {
        let at = Instant::now();
        let before = sample(at, &[(1, 1, 0)]);
        assert_eq!(before.usage(None, 4).cpu_percent, None);
        let after = sample(at + Duration::from_secs(4), &[(1, 1, 10_000_000)]);
        assert_eq!(after.usage(Some(&before), 4).cpu_percent, None);
    }

    #[test]
    fn sums_processes_and_normalizes_cpu_to_the_whole_machine() {
        let at = Instant::now();
        let before = sample(at, &[(1, 1, 0), (2, 2, 10_000_000)]);
        let after = sample(
            at + Duration::from_secs(1),
            &[(1, 1, 10_000_000), (2, 2, 20_000_000)],
        );
        let usage = after.usage(Some(&before), 4);
        assert_eq!(usage.cpu_percent, Some(50.0));
        assert_eq!(usage.memory_bytes, 2048);
    }

    #[test]
    fn process_churn_and_pid_reuse_do_not_charge_lifetime_cpu() {
        let at = Instant::now();
        let before = sample(at, &[(1, 1, 10)]);
        for processes in [
            vec![(1, 1, 20), (2, 2, 50_000_000)],
            vec![],
            vec![(2, 2, 50_000_000)],
            vec![(1, 3, 50_000_000)],
        ] {
            let after = sample(at + Duration::from_secs(1), &processes);
            assert_eq!(after.usage(Some(&before), 4).cpu_percent, None);
        }
    }
}
