# Christmas Memories

The public page at `/` hosts the interactive Christmas tree. Selected photos are converted to JPEG in the browser, sent with a short-lived upload ticket, and stored in R2. The photo inbox at `/admin` uses Sites sign-in and checks that the signed-in email matches the configured owner.

The hosting manifest binds the private R2 bucket as `BUCKET`. Configure the environment keys `OWNER_EMAIL`, `UPLOAD_SIGNING_KEY`, and `SITE_ORIGIN` in Sites. The signing key and owner email are runtime secrets.

Run `npm run build` followed by `npm run validate` to build the single Worker entrypoint in `dist/server/index.js`.
