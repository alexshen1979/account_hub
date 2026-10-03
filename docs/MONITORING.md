# Server monitoring

The admin overview includes a live server snapshot powered by [systeminformation](https://github.com/sebhildebrandt/systeminformation), an MIT-licensed Node.js library that supports Windows, Linux, and macOS.

The authenticated overview endpoint reports:

- Overall resource state
- Current CPU usage and logical core count
- Used and total memory
- Used and total space on the filesystem hosting Account Hub
- Host and Account Hub process uptime
- Operating system, architecture, processor, and Node.js version

Samples are cached for 15 seconds to avoid repeatedly running platform probes when several administrators refresh at once. If a platform probe fails, Account Hub falls back to Node.js built-in host and memory information and marks the state as unknown instead of failing the overview request.

While an administrator is signed in, the overview polls the snapshot endpoint every 15 seconds and plots CPU, memory, and disk usage with [Recharts](https://github.com/recharts/recharts). The chart retains the latest 40 unique samples in browser memory, starts fresh after logout or a page reload, and does not write monitoring data to the database.

Server details are returned only after administrator authentication. The feature does not persist metric history or send alerts. Long-term retention and alert routing should be provided by a dedicated monitoring stack when required.
