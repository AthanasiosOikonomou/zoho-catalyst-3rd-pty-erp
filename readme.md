# Zoho Catalyst 3rd-Party ERP Integration

A robust solution for integrating Zoho CRM with third-party ERP systems via Zoho Catalyst. This project streamlines data exchange, automates workflows, and enhances operational efficiency. It syncs customer/account data between a Galaxy ERP system and Zoho CRM. It is structured as a Node.js job (not a web server) and runs as a scheduled or manual process. The main entry point is `src/index.js`.

## Features

- Seamless integration with popular ERP platform.
- Automated data synchronization.
- Secure authentication and authorization.
- Error handling and logging.
- Scalable architecture.

## Getting Started

### Prerequisites

- Node.js >= 16.x
- Zoho Catalyst account
- Access credentials for your ERP system

### Installation

```bash
git clone https://github.com/your-org/zoho-catalyst-3rd-pty-erp.git
cd zoho-catalyst-3rd-pty-erp
npm install
```

### Configuration

Update the `.env` file with your Zoho Catalyst and ERP credentials.

### Usage

```bash
npm start
```

## Architecture & Data Flow

- **Session Management:**
  - `SessionStore` (`src/sessionStore.js`) persists session cookies (`sessionId`, `ssPid`) to a file for API authentication.
- **Galaxy ERP Integration:**
  - `apiClient.js` creates an Axios client for Galaxy API requests, attaching session cookies as needed.
  - `auth.js` handles authentication to Galaxy, extracting cookies from responses.
  - `customers.js` fetches customer data, using a high-watermark (`THIRDPARTYREVNUM`) to filter for new/updated records.
- **Zoho CRM Integration:**
  - `zohoAuth.js` manages Zoho OAuth2 tokens and data center selection.
  - `zohoAccounts.js` maps Galaxy customer data to Zoho Account fields and performs upserts.
- **Config & Environment:**
  - All config is loaded from environment variables via `src/config.js`. See required keys in that file.

## Key Patterns & Conventions

- **Manual Query Construction:**
  - Galaxy API filters are constructed as raw query strings (see `fetchCustomers` in `customers.js`). Do not use Axios `params` for these filters.
- **Session Persistence:**
  - Session cookies are read/written to a file (`SESSION_FILE` env var, default `.session.json`).
- **Error Handling:**
  - Errors are logged with context, especially for network/auth issues. See comments in `index.js` and `apiClient.js`.
- **Debugging:**
  - Set `DEBUG=1` in the environment to enable verbose request/response logging.

## Developer Workflows

- **Run the job:**
  - `npm start` or `node src/index.js`
- **Configuration:**
  - Create a `.env` file with all required variables (see `src/config.js` for validation logic).
- **Dependencies:**
  - Uses `axios` for HTTP, `node-cron` for scheduling (if used).

## External Integrations

- **Galaxy ERP:**
  - Auth via `/auth` endpoint, session cookies required for subsequent requests.
- **Zoho CRM:**
  - OAuth2 token management, data center selection via `ZOHO_DC` env var.

## Example: Fetching Customers

```js
// src/customers.js
const res = await fetchCustomers(api, maxZohoRev);
```

- `api` is the Axios client with session cookies attached.
- `maxZohoRev` is the high-watermark for incremental sync.

## Important Files

- `src/index.js`: Main job logic and orchestration
- `src/config.js`: Environment/config validation
- `src/apiClient.js`: Galaxy API client
- `src/auth.js`: Galaxy authentication
- `src/customers.js`: Customer fetch logic
- `src/zohoAccounts.js`: Zoho upsert logic
- `src/zohoAuth.js`: Zoho OAuth2/token logic
- `src/sessionStore.js`: Session persistence
