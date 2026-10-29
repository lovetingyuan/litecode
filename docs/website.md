# LiteCode website

The website is the `website/` directory: complete Chinese and English HTML pages, shared CSS and JavaScript, and local images, icons and fonts. It needs no Node.js dependencies, bundler, template engine or build command to publish. The desktop application's root `index.html`, Vite configuration and release process are independent.

## Preview and maintain

Serve `website/` with any static HTTP server, for example:

```powershell
python -m http.server 4174 --bind 127.0.0.1 --directory website
```

Open `http://127.0.0.1:4174/` or `/en/`. Edit the two HTML files directly; keep their content, anchors and metadata in sync. Shared styles and interactions live under `website/assets/`. Both languages remain readable with JavaScript disabled. Theme and manually chosen language preferences use local storage (`litecode-theme`, `litecode-language`); no analytics, forms, cookies or release API calls are included.

The default entry (`/` or `/index.html`, including project subpaths) automatically selects the remembered manual language, then the first supported language in the browser's preference list. All `zh-*` variants select Chinese and all `en-*` variants select English; unsupported preferences fall back to English. Visiting `/en/` explicitly keeps English. Language links use `?lang=zh` / `?lang=en` as explicit overrides, work when storage is blocked, and preserve the current query parameters and section anchor when JavaScript is available. Redirects use `location.replace` to avoid back-button loops. Common search/share crawlers and JavaScript-off visitors receive the original static language document; canonical and hreflang URLs stay unchanged.

Run `node tools/verify-website.mjs` from the repository to check the website with the existing development dependencies. This is a development check, not a deployment step. It tests both languages and both themes, responsive layouts, system theme changes, keyboard navigation, disabled JavaScript and storage, reduced motion, metadata and resource paths. It also serves the files under `/litecode/` to check project-site compatibility. Results and visual captures are written under `.verification/website-review/`.

## Publish with GitHub Pages

1. Push the website and `.github/workflows/pages.yml` to the official `lovetingyuan/litecode` repository's `main` branch.
2. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**.
3. Run **Actions → Deploy website to GitHub Pages → Run workflow**, or push a change under `website/`. The workflow uploads that directory directly, without installing dependencies or building the desktop app.
4. Before binding a domain, check the default project address: `https://lovetingyuan.github.io/litecode/`. Relative asset and language links support the project path.

The workflow targets `main`, matching the official application's documented release branch. If publishing from a repository with another default branch, change the workflow branch filter. This local source checkout may have a differently named branch; it does not control the production workflow.

## Bind litecode.tingyuan.in through Cloudflare

1. In GitHub **Settings → Pages → Custom domain**, enter `litecode.tingyuan.in` and save it **before** adding the DNS record.
2. In Cloudflare DNS for `tingyuan.in`, add:

   | Type | Name | Target | Proxy | TTL |
   | --- | --- | --- | --- | --- |
   | CNAME | `litecode` | `lovetingyuan.github.io` | DNS only | Auto |

3. The target is the GitHub account hostname. Do not include `https://`, `/litecode`, or a `*.pages.github.io` hostname. Keep CNAME flattening disabled for this record so verification can see the CNAME.
4. After GitHub's DNS check and certificate provisioning complete, enable **Enforce HTTPS** in Pages settings. DNS and certificate changes can take up to 24 hours.
5. Confirm both `https://litecode.tingyuan.in/` and `/en/`, and that the default GitHub Pages address redirects to the custom domain. Keep DNS only for this configuration; GitHub supplies HTTPS.

The included `website/CNAME` records the intended hostname and supports branch-based publication. **GitHub Actions deployments ignore this file: the custom domain must still be set in Pages settings.** No Cloudflare account credentials or DNS mutations are part of the repository.

References: [GitHub custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site), [Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [Cloudflare CNAME verification](https://developers.cloudflare.com/dns/manage-dns-records/troubleshooting/cname-domain-verification/).

## SEO and downloads

- The canonical domain is `https://litecode.tingyuan.in/`. Each language has its own canonical URL and reciprocal `hreflang` links. If the domain changes, update HTML metadata, structured data, the 404 return links, sitemap, robots and CNAME together.
- The 404 page uses canonical absolute links so returning home also works from arbitrarily nested missing paths. During project-path-only staging, those return links intentionally lead to the future canonical site.
- All download buttons point to `https://github.com/lovetingyuan/litecode/releases`; no filenames, version numbers or package sizes are hardcoded. Publishing this site does not publish the software.
- Software claims are bounded to Windows 11 x64 and existing features. No built in AI assistant, full VS Code extension compatibility, benchmark or licensing claim is made.

## Asset sources and screenshots

- `assets/logo.svg` reuses the application's `public/litecode.svg`. PNG favicons and touch icons are rendered from that SVG. The social card is a branded typography composition rendered locally, not an AI generated product screenshot.
- `assets/icons.svg` contains small, original geometric SVG interface icons using one consistent stroke style.
- `assets/fonts/manrope-latin.woff2` is the Latin variable subset of Manrope, obtained from [Google Fonts](https://fonts.google.com/specimen/Manrope). Its SIL Open Font License is included beside the file. Chinese uses installed system fonts.
- Product screenshots show the real release executable with the same illustrative Daylight Vite + TypeScript project. The demo is sample content, not a customer project. Run `node tools/capture-website.mjs` to recreate the project and captures after building the current application (`npm run build` then `cargo build --release --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml`). The `custom-protocol` feature embeds the production frontend. This requires Windows, WebView2, the existing Node dependencies, application language tools and FFmpeg on PATH.
- The capture tool keeps the demo project, isolated portable app data, original PNG captures and provenance report under `.verification/website/`. Only optimized WebP exports are published. It does not touch the user's normal LiteCode workspace, settings or Git projects, and it never pushes the demo repository.
