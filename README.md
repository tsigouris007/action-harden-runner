## Action Harden Runner

### Description

Metapod used Harden. It's very effective.

This action runs a non blocking monitor in the background while your workflows run. After completion, you receive a post action full report with all the connections made during your workflow. You can allow or block connections to your workflows to avoid malicious external calls (supply-chain attacks) that might occur while running (e.g. [Tj-actions/changed-files GitHub Action Compromised](https://news.ycombinator.com/item?id=43367987) or [tj-actions issue #13456](https://github.com/tj-actions/changed-files/issues/2464)).

### Inputs

| name | description | required | default |
| --- | --- | --- | --- |
| `config` | <p>Configuration file path. To use this you have to checkout first and put your own path as input.</p> | `false` | `""` |
| `mode` | <p>Mode to run the action. Allowed: 'log', 'block'. Default: 'log'.</p> | `false` | `log` |
| `block_na` | <p>Block all N/A connections. Default: 'false'.</p> | `false` | `false` |
| `interval` | <p>Monitoring polling interval in seconds. Default: '1'.</p> | `false` | `1` |
| `debug` | <p>Enable debug mode. Default: 'false'.</p> | `false` | `false` |


### Runs

This action is a `node20` action.

### Usage

```yaml
- uses: skroutz-internal/action-harden-runner@main # or a specific version
  with:
    config: ./custom-config.yaml
    # Configuration file path. To use this you have to checkout first and put your own path as input.
    #
    # Required: false
    # Default: ""

    mode: "log"
    # Mode to run the action. Allowed: 'log', 'block'. Default: 'log'.
    #
    # Required: false
    # Default: log

    block_na: "false"
    # Block all N/A connections. Default: 'false'.
    #
    # Required: false
    # Default: false

    interval: "1"
    # Monitoring polling interval in seconds. Default: '1'.
    #
    # Required: false
    # Default: 1

    debug: "false"
    # Enable debug mode. Default: 'false'.
    #
    # Required: false
    # Default: false
```

1. `config`: Make sure your configuration file exists. If it does not exist, a default one will be used from this action from the `src/` directory. You have to checkout your repository first in order to pass a custom `config` to the action.
2. `mode`: When running for the first time prefer the `log` option to retrieve a list of IPs / domains / processes that you would like to whitelist. Then move on to the blocking side of things at your discretion.
3. `block_na`: Very aggressive, blocking everything that is not included in the allow lists. May hang your workflow.
4. `interval`: A suggested value for starters is between 0.5 - 1. You can operate in smaller intervals but that makes things more CPU intensive. Still, the action is very lightweight and runs in the background. Tests on values of 0.2 - 0.5 were also successful. Note that a big interval might miss connections.
5. `debug`: A debug log for your run. If enabled, a really verbose output will be at your disposal.

You can also maintain a JSON artifact file as shown upon completion with a simple step:
```yaml
- name: Upload Harden Runner Summary
  uses: actions/upload-artifact@vX.X.X # Replace with your version
  with:
    name: harden-runner-connections.json
    path: harden-runner-connections.json
```
This static file is created while the action is running. If you are committing stuff in your workflow make sure to ignore it via `.gitignore` if you do not want it. If you remove it earlier you will break the action's functionality.

### Config

Sample configuration file:
```yaml
allow:
  ip4:
    - 127.0.0.1/24
  ip6:
    - ::1/128
  domain:
    - "localhost"
    - "*.github.com"
    - "*.google.*"
  process:
    - "curl"
block:
  ip4:
    - 8.8.8.8/32
  ip6:
    - 2001:4860:4860::8888/128
  domain:
    - "*evil.com"
    - "*malicious*"
    - "malware.com"
  process:
    - "wget"
```

You can omit any of the elements. They are in an array format so that you can append as many as you want.

#### Note

The configuration has to be manually created - you can use the table output from the post action - and supports:
- IPv4 / IPv6 CIDR notation.
- Domain exact and wildcard matching.
- Process name exact matching.

## Internals

The action initiates a background `monitor` process that polls and parses `netstat` output. Upon `block` mode and if able, the `monitor` issues a `SIGKILL` to the `pid` of the blocked process and adds an `iptables` rule - or only adds the rule if the `kill` cannot occur. That might end your workflow execution abruptly, but this is actually the main goal of this action.

An `ebpf` alternative is on its way.
