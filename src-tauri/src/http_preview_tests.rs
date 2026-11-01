use super::*;
use std::{fs, time::Duration};

fn fixture() -> tempfile::TempDir {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tmp");
    fs::create_dir_all(&directory).unwrap();
    tempfile::tempdir_in(directory).unwrap()
}

async fn stop(service: &Service, label: &str, id: Option<u64>) {
    let (servers, _) = service.remove(label, id);
    for mut server in servers {
        let _ = server.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(3), &mut server.done)
            .await
            .unwrap()
            .unwrap();
        let listener = bind(server.info.port).unwrap();
        assert_eq!(listener.local_addr().unwrap().port(), server.info.port);
    }
}

#[test]
fn ports_are_automatic_preferred_or_fall_back_when_occupied() {
    let default_http = HttpRoot {
        directory: PathBuf::new(),
        authority: "127.0.0.1:80".into(),
    };
    assert!(default_http.allows_host(Some("127.0.0.1")));
    assert!(default_http.allows_host(Some("127.0.0.1:80")));
    assert!(!default_http.allows_host(Some("foreign.example")));
    let other_port = HttpRoot {
        directory: PathBuf::new(),
        authority: "127.0.0.1:5500".into(),
    };
    assert!(!other_port.allows_host(Some("127.0.0.1")));
    let automatic = bind(0).unwrap();
    let occupied = automatic.local_addr().unwrap().port();
    assert_ne!(occupied, 0);
    let fallback = bind(occupied).unwrap();
    assert_ne!(fallback.local_addr().unwrap().port(), occupied);
    drop(automatic);
    assert_eq!(
        bind(occupied).unwrap().local_addr().unwrap().port(),
        occupied
    );
}

#[tokio::test]
async fn serves_files_assets_special_names_heads_and_media_ranges() {
    let fixture = fixture();
    let root = fs::canonicalize(fixture.path()).unwrap();
    fs::write(root.join("index.html"), "<script src='app.js'></script>").unwrap();
    fs::write(root.join("app.js"), "console.log('preview')").unwrap();
    fs::write(root.join("style.css"), "body{}").unwrap();
    fs::write(root.join("中文 #%.html"), "special page").unwrap();
    fs::write(root.join("clip.mp4"), b"0123456789").unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/index.html"), "nested page").unwrap();
    fs::create_dir(root.join("empty")).unwrap();
    let service = Service::default();
    let started = service
        .start("main", &root.join("中文 #%.html"), 0, |_| {})
        .unwrap();
    let info = &started.snapshot.services[0];
    let base = format!("http://127.0.0.1:{}/", info.port);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let special = client.get(&started.url).send().await.unwrap();
    assert_eq!(special.status(), StatusCode::OK);
    assert_eq!(special.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(special.text().await.unwrap(), "special page");
    for (path, mime, content) in [
        ("", "text/html", "<script src='app.js'></script>"),
        ("app.js", "javascript", "console.log('preview')"),
        ("style.css", "text/css", "body{}"),
        ("nested/", "text/html", "nested page"),
    ] {
        let response = client.get(format!("{base}{path}")).send().await.unwrap();
        assert!(response.status().is_success());
        assert!(
            response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .contains(mime)
        );
        assert_eq!(response.text().await.unwrap(), content);
    }
    let response = client.head(&started.url).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.bytes().await.unwrap().is_empty());
    let response = client
        .get(format!("{base}clip.mp4"))
        .header("range", "bytes=2-5")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"2345");
    for path in ["missing", "empty/"] {
        assert_eq!(
            client
                .get(format!("{base}{path}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        client.post(&base).send().await.unwrap().status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        client
            .get(&base)
            .header("host", "foreign.example")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    fs::write(root.join("index.html"), "saved change").unwrap();
    assert_eq!(
        client
            .get(&base)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "saved change"
    );
    stop(&service, "main", None).await;
}

#[tokio::test]
async fn concurrent_starts_reuse_directories_and_isolate_windows() {
    let fixture = fixture();
    let root = fs::canonicalize(fixture.path()).unwrap();
    let file = root.join("index.html");
    let other = root.join("second.html");
    fs::write(&file, "one").unwrap();
    fs::write(&other, "two").unwrap();
    let service = Service::default();
    let mut starts = Vec::new();
    for _ in 0..8 {
        let service = service.clone();
        let file = file.clone();
        starts.push(tokio::spawn(async move {
            service.start("main", &file, 0, |_| {}).unwrap()
        }));
    }
    let first = starts.remove(0).await.unwrap();
    for start in starts {
        assert_eq!(start.await.unwrap().url, first.url);
    }
    assert_eq!(service.snapshot("main").services.len(), 1);
    let same = service.start("main", &other, 0, |_| {}).unwrap();
    assert_eq!(same.snapshot.services[0].id, first.snapshot.services[0].id);
    assert_eq!(same.snapshot.services[0].url, same.url);
    assert!(same.url.ends_with("/second.html"));
    fs::create_dir(root.join("sub")).unwrap();
    fs::write(root.join("sub/index.html"), "sub").unwrap();
    let nested = service
        .start("main", &root.join("sub/index.html"), 0, |_| {})
        .unwrap();
    assert_eq!(nested.snapshot.services.len(), 2);
    let second = service.start("other-window", &file, 0, |_| {}).unwrap();
    assert_ne!(
        first.snapshot.services[0].port,
        second.snapshot.services[0].port
    );
    // Another window cannot stop the first window's service by guessing its id.
    stop(
        &service,
        "other-window",
        Some(first.snapshot.services[0].id),
    )
    .await;
    assert_eq!(service.snapshot("main").services.len(), 2);
    assert_eq!(service.snapshot("other-window").services.len(), 1);
    stop(&service, "main", Some(first.snapshot.services[0].id)).await;
    assert_eq!(service.snapshot("main").services.len(), 1);
    let snapshot = service.close_window("main");
    assert!(snapshot.services.is_empty());
    assert!(snapshot.revision > nested.snapshot.revision);
    assert_eq!(service.snapshot("other-window").services.len(), 1);
    stop(&service, "other-window", None).await;
}

#[tokio::test]
async fn rejects_traversal_and_links_outside_the_root_including_default_index() {
    let fixture = fixture();
    let outside = fs::canonicalize(fixture.path()).unwrap();
    let root = outside.join("public");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("index.html"), "public").unwrap();
    fs::write(outside.join("secret.txt"), "private").unwrap();
    for path in [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/%2e%2e%2fsecret.txt",
        "/%2e%2e%5csecret.txt",
        "/C:/secret.txt",
        "/%00",
    ] {
        assert!(checked_path(&root, path).await.is_err(), "{path}");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let secret = outside.join("secret");
        fs::create_dir(&secret).unwrap();
        fs::write(secret.join("index.html"), "private index").unwrap();
        fs::write(secret.join("secret.txt"), "private").unwrap();
        // Junctions exercise Windows reparse-point escapes without symlink privileges.
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("linked"))
            .arg(&secret)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(checked_path(&root, "/linked/secret.txt").await.is_err());
        assert!(checked_path(&root, "/linked/").await.is_err());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        assert!(checked_path(&root, "/link.txt").await.is_err());
        fs::create_dir(root.join("nested")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("nested/index.html"))
            .unwrap();
        assert!(checked_path(&root, "/nested/").await.is_err());
    }
}
