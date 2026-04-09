# Setting Up AWS Bedrock Guardrails for Research Scanning

The web research tool can optionally scan queries and results using AWS Bedrock Guardrails to detect:
- **Input**: PII, secrets, and sensitive data before sending queries to Perplexity
- **Output**: Prompt injection attempts in web research results

Scanning is optional. Without configuration, the tool works normally with a warning in the console.

## Prerequisites

- An AWS account with Bedrock access enabled in your region
- AWS credentials available to the application (EC2 instance role, env vars, or `~/.aws/credentials`)

## Step 1: Create a Guardrail

### Via AWS Console

1. Go to **Amazon Bedrock** → **Guardrails** → **Create guardrail**
2. Name it (e.g., `archie-research-scanner`)

#### Configure Content Filters

Under **Content filters**, enable:
- **Prompt Attack** filter with strength **HIGH** — this detects injection/jailbreaking in research results
  - Enable for **Output** (we scan Perplexity responses)

#### Configure Sensitive Information Filters

Under **Sensitive information filters**, add PII entities to detect in input:

**Recommended PII entities** (set action to **BLOCK**):
- `EMAIL`
- `PHONE`
- `CREDIT_DEBIT_CARD_NUMBER`
- `US_SOCIAL_SECURITY_NUMBER`
- `AWS_ACCESS_KEY`
- `AWS_SECRET_KEY`
- `NAME` (optional — may be too aggressive for some research queries)

**Custom regex patterns** for API keys/tokens (set action to **BLOCK**):

| Name | Pattern | Description |
|------|---------|-------------|
| `anthropic_api_key` | `sk-ant-[a-zA-Z0-9_-]{20,}` | Anthropic API keys |
| `openai_api_key` | `sk-[a-zA-Z0-9]{20,}` | OpenAI API keys |
| `github_token` | `gh[ps]_[a-zA-Z0-9]{36,}` | GitHub personal/service tokens |
| `slack_token` | `xox[bpas]-[a-zA-Z0-9-]+` | Slack bot/user tokens |
| `generic_secret` | `(?i)(password|secret|token)\s*[:=]\s*\S{8,}` | Generic secrets in key=value format |

> Note: Bedrock regex does **not** support lookaround. Keep patterns simple.

#### Configure Blocked Messages

Set descriptive messages:
- **Blocked input message**: `Research query blocked: contains sensitive information that should not be sent to external services.`
- **Blocked output message**: `Research result blocked: potential prompt injection detected in web content.`

3. Click **Create guardrail**
4. Note the **Guardrail ID** (e.g., `abc123def456`)

### Via AWS CLI

```bash
aws bedrock create-guardrail \
  --name archie-research-scanner \
  --blocked-input-messaging "Research query blocked: contains sensitive information." \
  --blocked-outputs-messaging "Research result blocked: potential prompt injection detected." \
  --content-policy-config '{
    "filtersConfig": [
      {
        "type": "PROMPT_ATTACK",
        "inputEnabled": false,
        "outputEnabled": true,
        "outputStrength": "HIGH",
        "outputAction": "BLOCK"
      }
    ]
  }' \
  --sensitive-information-policy-config '{
    "piiEntitiesConfig": [
      {"type": "EMAIL", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false},
      {"type": "PHONE", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false},
      {"type": "CREDIT_DEBIT_CARD_NUMBER", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false},
      {"type": "US_SOCIAL_SECURITY_NUMBER", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false},
      {"type": "AWS_ACCESS_KEY", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false},
      {"type": "AWS_SECRET_KEY", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false}
    ],
    "regexesConfig": [
      {"name": "anthropic_api_key", "pattern": "sk-ant-[a-zA-Z0-9_-]{20,}", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false},
      {"name": "openai_api_key", "pattern": "sk-[a-zA-Z0-9]{20,}", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false},
      {"name": "github_token", "pattern": "gh[ps]_[a-zA-Z0-9]{36,}", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false},
      {"name": "slack_token", "pattern": "xox[bpas]-[a-zA-Z0-9-]+", "inputAction": "BLOCK", "inputEnabled": true, "outputEnabled": false}
    ]
  }' \
  --region us-east-1
```

Then publish the draft:

```bash
aws bedrock create-guardrail-version \
  --guardrail-identifier <GUARDRAIL_ID> \
  --region us-east-1
```

## Step 2: Configure Environment Variables

Add to your `.env` or container environment:

```bash
# Required — the guardrail ID from Step 1
BEDROCK_GUARDRAIL_ID=abc123def456

# Optional — defaults shown
BEDROCK_GUARDRAIL_VERSION=DRAFT    # or "1", "2", etc. for published versions
AWS_REGION=us-east-1               # region where the guardrail was created
```

AWS credentials are picked up automatically from:
- EC2 instance role (recommended for production)
- `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` env vars
- `~/.aws/credentials` file

## Step 3: Verify

Start the application and trigger a research query. You should see in the logs:

```
[research:abcd1234] Starting research
[research:abcd1234]   Topic: ...
```

**Without** `BEDROCK_GUARDRAIL_ID`, you'll see a one-time warning:
```
[WARN] [research] BEDROCK_GUARDRAIL_ID not set — research scanning disabled
```

**To test input blocking**, ask the agent to research something containing PII:
> "Research the account details for user with SSN 123-45-6789"

Expected: research is blocked with an error message.

**To test output scanning**, the guardrail will scan Perplexity responses automatically. Prompt injection in web content will be caught and blocked.

## How It Works

The scanning happens at two points in the research flow:

```
1. Agent calls web_research(topic, context)
2. Budget check
3. ► INPUT SCAN: topic + context → ApplyGuardrail(source=INPUT)
   → If blocked: return error (PII/secrets detected)
4. Classify preset (Haiku)
5. Call Perplexity API
6. ► OUTPUT SCAN: response text → ApplyGuardrail(source=OUTPUT)
   → If blocked: return error (prompt injection detected)
7. Save report.md
8. Return result to agent
```

Scanning is **fail-open**: if the AWS call fails (network error, permissions, etc.), the research proceeds with a warning in the console. This prevents AWS issues from breaking the research tool entirely.

## Cost

At typical research volumes (5-10 queries per task, a few tasks per day):
- **Content policy** (prompt attack): ~$0.15 per 1,000 text units
- **Sensitive information** (PII): ~$0.10 per 1,000 text units
- Custom regex patterns are free

Expect **under $5/month** at low volume. See [Bedrock Guardrails pricing](https://aws.amazon.com/bedrock/pricing/) for details.

## Related

- [Web Research Architecture](../architecture/web-research.md)
- [Security Architecture](../architecture/security.md)
