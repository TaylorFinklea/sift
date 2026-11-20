# Documentation

## Using and running Sift

- [Using Sift](user-guide.md): rounds, review, ratings and library transfers
- [HTTP API](api.md): endpoints, concurrency rules and limits
- [Self-hosting](self-hosting.md): the container behind an access proxy, or Cloudflare Workers and D1

## Specifications

- [`.sift.json` transfer format](transfer-format.md): the archive shared with the native iPhone app
- [Numeric values and rating rounds](ratings-contract.md): the cross-runtime contract for ratings

## Project records

These record how the project was built and released. They are kept for history and are not needed to use or run Sift.

- [`reviews/`](reviews/): adversarial review reports and receipts from independent models, one set per feature and release
- [`cloudflare-launch.md`](cloudflare-launch.md) and [`cloudflare-deployment.md`](cloudflare-deployment.md): the production launch plan and deployment records
- [`app-store-website-access-plan.md`](app-store-website-access-plan.md): the plan for public privacy and support pages
- [`design/`](design/) and [`qa/`](qa/): the original design concept and visual QA captures, with [`design-qa.md`](design/design-qa.md)
- [`screenshots/`](screenshots/): current screenshots used in the README
