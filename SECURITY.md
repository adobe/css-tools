            - name: Wait/watch an execution task in Octopus Deploy
  # You may pin to the exact commit or the version.
  # uses: OctopusDeploy/await-task-action@df7319c026caef02341eb8b702771276b3c445f3
  uses: OctopusDeploy/await-task-action@v3.0.2
  with:
    # The execution task ID to watch/wait for.
    server_task_id: 
    # How frequently, in seconds, to check the status.
    polling_interval: # optional, default is 10
    # Duration, in seconds, to allow for completion before timing out.
    timeout_after: # optional, default is 600
    # Whether to hide the progress of the task.
    hide_progress: # optional
    # The instance URL hosting Octopus Deploy (i.e. "https://octopus.example.com/"). The instance URL is required, but you may also use the OCTOPUS_URL environment variable.
    server: # optional
    # The API key used to access Octopus Deploy. An API key is required, but you may also use the OCTOPUS_API_KEY environment variable. It is strongly recommended that this value retrieved from a GitHub secret.
    api_key: # optional
    # The name of a space within which this command will be executed. The space name is required, but you may also use the OCTOPUS_SPACE environment variable.
    space: # optional
          # Security Policy

## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 5.1.x   | :white_check_mark: |
| 5.0.x   | :x:                |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

Use this section to tell people how to report a vulnerability.

Tell them where to go, how often they can expect to get an update on a
reported vulnerability, what to expect if the vulnerability is accepted or
declined, etc.
