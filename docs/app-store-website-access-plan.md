# Public App Store pages: Cloudflare Access plan

This plan covers only the public policy exceptions needed for the website privacy and support pages. It does not authorize a Cloudflare change or deployment.

## Exact change

On the existing Access application for `sift.example.com`, add destination overrides with behavior `public` for these exact path patterns only:

- `/privacy`
- `/support`

Cloudflare documents these as destination overrides on an Access application. Read the current application configuration immediately before editing and preserve its hostname, existing policies, session duration, and all other settings. Do not use wildcard paths, prefix matching, a second broad public application, or an exception on `api.sift.example.com`.

The Worker independently serves only `GET` and `HEAD` for those exact paths and validates a page-specific marker in the asset response. All other methods, paths, and hosts continue through the existing Worker authentication. A failed asset lookup returns 404 rather than the private app shell.

## Reversal

Remove only the two `/privacy` and `/support` public destination overrides. This restores the prior whole-host Access gate for those routes. Do not change the rest of the application or Worker routes as part of reversal.

## Verification after a separately authorized change

- Anonymous `GET` and `HEAD` to `https://sift.example.com/privacy` and `/support` reach the intended static documents.
- Anonymous requests to `/`, private app assets, `/api/*`, `/privacy/`, `/support/`, nested or encoded variants, and all non-GET/HEAD methods remain protected by Access or the Worker.
- Requests to `https://api.sift.example.com/privacy` remain on the API hostname's existing bearer-key path and do not receive a public page exception.
- Confirm the live Access application still has all original non-path settings and policies.

Cloudflare API reference: [Get Access applications](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/applications/methods/get/). Current production configuration must be freshly read and reviewed before any change.
