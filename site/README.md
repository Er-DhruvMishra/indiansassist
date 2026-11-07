# The project website (indiansassist.com)

Plain HTML and CSS, no build step, no scripts, no third-party fonts or analytics. Published to GitHub Pages by
`.github/workflows/pages.yml` on every push to `master` that changes `site/**`, and by hand from the Actions tab
(**pages**, **Run workflow**).

| File | Page |
|---|---|
| `index.html` | Home: what IndiansAssist is, the features, the code signing statement, links |
| `download.html` | Every platform, what it does, its signing status today, how to verify checksums and signatures |
| `code-signing.html` | The code signing policy (same content as `CODE_SIGNING_POLICY.md`) |
| `privacy.html` | The privacy policy (same content as `PRIVACY.md`) |
| `security.html` | Reporting a vulnerability (same content as `SECURITY.md`) |
| `license.html` | AGPL-3.0-only and the source links |
| `404.html` | Not found (links are absolute because it is served at any path) |
| `style.css` | The one stylesheet; light and dark follow the system setting |
| `keys/` | The public signing keys (maintained with the release signing, not by hand here) |
| `CNAME` | `indiansassist.com`, the custom domain |

**Keep the policy pages in step with the Markdown files.** When `PRIVACY.md`, `CODE_SIGNING_POLICY.md` or `SECURITY.md`
changes, make the same change in the matching page here, in the same commit. Every page carries the same header and
the footer (Code signing policy, Privacy, Security, Source, Licence); the workflow fails if a page has a script, has no
`<title>`, or is missing a footer link.

## One-time setup by the owner

1. **Make the repository public** (GitHub Pages needs a public repository on the free plan, or a paid plan while it is
   private).
2. **Enable Pages:** repository **Settings**, **Pages**, **Build and deployment**, **Source**: **GitHub Actions**.
3. **Run the workflow once:** **Actions**, **pages**, **Run workflow** (or push a change under `site/`).
4. **Custom domain:** **Settings**, **Pages**, **Custom domain**: `indiansassist.com`, **Save**. GitHub checks the DNS
   (step 5). Optionally verify the domain for your account first (**Settings** of your profile, **Pages**, **Add a
   domain**), which stops anyone else from claiming it.
5. **DNS at the domain registrar** for `indiansassist.com`:
   - `A` records for the apex `indiansassist.com`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
     `185.199.111.153`;
   - `AAAA` records for the apex: `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`,
     `2606:50c0:8003::153`;
   - a `CNAME` record for `www` pointing to `er-dhruvmishra.github.io`;
   - remove any other `A`, `AAAA` or `ALIAS` records on the apex that point elsewhere.

   These are GitHub's published Pages addresses; check them against
   <https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site>
   when you set them.
6. **Enforce HTTPS:** once GitHub has issued the certificate (it can take up to a day after DNS resolves), tick
   **Enforce HTTPS** on the same Pages settings page.

If the IndiansAssist hosted service later runs under the same domain, keep the website on the apex and `www`, and give
the service its own sub-domains (for example one per data region), so the two never collide.
