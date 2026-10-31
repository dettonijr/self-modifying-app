# The Canvas is served straight from git commits, with no build step

The Canvas server reads files directly from the commit `main` points to, from git objects rather than a working folder. Landing is therefore just moving `main`: it's atomic, viewers never see a half-updated Canvas, and Rollback is just another commit. This requires the Canvas to be plain HTML, CSS and JS modules, with libraries loaded from CDNs through import maps. There's no bundler and no `npm install`, which also removes a build step that could fail during Landing and a build setup Claude could break.
