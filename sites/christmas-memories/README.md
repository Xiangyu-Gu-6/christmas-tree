# Christmas Memories

The public page at `/` hosts the shared Christmas tree. Visitors see the latest 12 public photos and can load earlier batches. Selected photos are converted to JPEG in the browser and sent to `/api/shared-photos` using a short-lived upload ticket. A chronological index in R2 lists public photos separately from their upload quota slots.

The owner-only archive at `/admin` still uses Sites sign-in and holds earlier private uploads. New uploads go to the shared tree. Open pages from the earlier version must refresh before they can upload with the public disclosure.

The hosting manifest binds the private R2 bucket as `BUCKET`. Configure the environment keys `OWNER_EMAIL`, `UPLOAD_SIGNING_KEY`, and `SITE_ORIGIN` in Sites. The signing key and owner email are runtime secrets.

Run `npm run build` followed by `npm run validate` to build the single Worker entrypoint in `dist/server/index.js`.
