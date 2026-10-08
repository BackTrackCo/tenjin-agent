---
'tenjin-cli': patch
---

`PRODUCTION_ORIGIN` is now `https://tenjin.sh`; `KNOWN_DEPLOYMENT_ORIGINS` keeps
both hosts, so a CLI on either default reaches the same deployment.
