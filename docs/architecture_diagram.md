# Two-repo architecture diagram

```
+----------------------------------------------------------+
| shiftboss (OSS core)                                     |
| - Next.js UI (PWA)                                       |
| - Local API + runner                                     |
| - SQLite state + Work Orders                             |
| - Chat, tech tree, portfolio                             |
+----------------------------+-----------------------------+
                             |
                             | optional cloud calls
                             v
+----------------------------------------------------------+
| shiftboss cloud (closed-source services)                 |
| - Auth and billing                                       |
| - VM provisioning and monitoring                         |
| - Hosted observability and alerts                        |
| - Marketing site                                         |
+----------------------------------------------------------+

Self-hosted mode runs only the core box on your machine.
Cloud mode connects the core to separately developed managed services.
```
