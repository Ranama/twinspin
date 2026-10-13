# Putting TwinSpin on GitHub

This puts the project in your GitHub repository `twinspin` and publishes the app on GitHub Pages at
https://ranama.github.io/twinspin/ (repository https://github.com/Ranama/twinspin). If you fork it, replace `Ranama` with your own GitHub user name everywhere
below. It takes about ten minutes, most of it waiting.

## 1. Create an empty repository

On github.com click **+ -> New repository**:

* **Repository name:** `twinspin`
* **Public.** GitHub Pages on a free account only works for public repositories.
* Leave **Add a README**, **.gitignore** and **license** switched off. The repository must be empty, or the
  first push is rejected.

Click **Create repository**.

## 2. Push the project

Git needs a name and an e-mail address for every commit, and GitHub shows both publicly. To keep your private
address out of the repository, use the address GitHub gives you for this: it is shown under **Settings -> Emails**
(with **Keep my email addresses private** ticked) and looks like `12345678+Ranama@users.noreply.github.com`.
Set it once for this repository, in a terminal in the TwinSpin folder:

```
git config user.name "Ranama"
git config user.email "12345678+Ranama@users.noreply.github.com"
```

Everything must be committed first (`git status` says "nothing to commit"). Then (PowerShell or Git Bash):

```
git remote add origin https://github.com/Ranama/twinspin.git
git branch -M main
git push -u origin main
```

The first push opens a browser window to sign in to GitHub (Git Credential Manager, part of Git for Windows).
Git never sees your password.

**Push rejected with "GH007: Your push would publish a private email address"?** Some commits were made before
the `git config` lines above and still carry your private e-mail address, and your GitHub settings block that.
With the two `git config` lines done, rewrite those commits once before the push goes through. Run this in Git
Bash (it keeps the messages and dates; the commits get new IDs, which is fine because nothing was pushed yet):

```bash
git rebase --root --exec 'git commit --amend --no-edit --author="$(git config user.name) <$(git config user.email)>"'
```

Then run `git push -u origin main` again. (Unticking **Block command line pushes that expose my email** under
Settings -> Emails also works, but then your private address is public in the repository.)

## 3. Switch on GitHub Pages

In the repository: **Settings -> Pages -> Build and deployment -> Source: GitHub Actions**. There is nothing
else to choose and nothing to save.

## 4. Wait for the green check marks

Open the **Actions** tab. The first push runs two workflows:

* **CI** checks every module and runs all tests (Linux, about 2 minutes).
* **Deploy to GitHub Pages** runs the tests, builds the website and publishes it (about 5 minutes).

If you pushed before step 3, the first **Deploy to GitHub Pages** run fails at "Configure GitHub Pages" with
*Get Pages site failed*. That is expected: open the run and click **Re-run all jobs** (or **Deploy to GitHub
Pages -> Run workflow -> main**).

## 5. Open the app

https://ranama.github.io/twinspin/ (the link is also on the finished deploy run). On a phone, open
it in Safari or Chrome and install it to the home screen (see the README). To see which version is live, open
https://ranama.github.io/twinspin/build.txt.

## Updating

Commit and `git push`. Every push to `main` that changes the app publishes a new version, and installed apps
show **Update ready**. Pushes that only change documentation, tests or JsCheck do not publish; to publish anyway,
use **Actions -> Deploy to GitHub Pages -> Run workflow**.

## Alternative: publish from your PC to the gh-pages branch

Without Actions, `tools\publish-web.ps1` builds the same website on your PC and pushes it to the `gh-pages`
branch of the repository (your `main` branch and its history are not touched):

```powershell
powershell -ExecutionPolicy Bypass -File tools\publish-web.ps1 -Repo Ranama/twinspin -Open
```

Then set **Settings -> Pages -> Source: Deploy from a branch -> Branch: gh-pages, / (root) -> Save**. Use one
route, not both: with this one, switch the Actions route off under **Actions -> Deploy to GitHub Pages -> ...
-> Disable workflow**. Run the same command again to publish an update.

## What the workflows do

| File | When | What |
|---|---|---|
| `.github/workflows/ci.yml` | every push (except `gh-pages`) and pull request | Builds JsCheck, then `tools/JsCheck/jscheck check src tests --strict` and `tools/JsCheck/jscheck test tests` on Linux. Warns if `sw.js` misses a file in its development offline list. |
| `.github/workflows/pages.yml` | pushes to `main` that change the app, or by hand | On Windows: the tests, then `tools\publish-web.ps1 -Ci`, which builds `site/` with only the runtime files, stamps the service worker version and offline file list, writes `404.html` for the `/twinspin/` address and checks every module. Then GitHub Pages serves `site/`. |

`tests/realsongs.test.js` needs your own songs in `tests/media/`, which is never committed, so on GitHub it skips
them.

## If something goes wrong

| Problem | Fix |
|---|---|
| Push rejected: *Updates were rejected because the remote contains work that you do not have locally* | The repository was not empty (a README or license was added when it was made). If you do not need those files: `git push -u --force origin main`. |
| Push rejected: *GH007 ... private email address* | See step 2. |
| Deploy fails at "Configure GitHub Pages": *Get Pages site failed* | Do step 3, then re-run the workflow. |
| Deploy fails: *Branch "main" is not allowed to deploy to github-pages due to environment protection rules* | **Settings -> Environments -> github-pages -> Deployment branches and tags**: add `main`. |
| The site answers 404 | Wait a minute after the first deploy. The address ends in `/twinspin/` and is case-sensitive. |
| "Run tests" failed | Open the run to see which test failed. Run the same test on your PC: `tools/JsCheck/jscheck run tests/<name>.test.js`. |
| The repository is private | GitHub Pages needs a paid plan for private repositories. Make it public under **Settings -> General -> Danger Zone -> Change visibility**. |
