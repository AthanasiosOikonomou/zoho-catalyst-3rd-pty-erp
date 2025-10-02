# Galaxy ERP to Zoho CRM Synchronization via Zoho Catalyst

## Project

| Metric        | Value                                         | Status           |
| :------------ | :-------------------------------------------- | :--------------- |
| **Type**      | ETL (Extract, Transform, Load)                | Production-Ready |
| **Platform**  | Zoho Catalyst Node.js                         | Stable           |
| **Execution** | Cron Job (`fetchAccountsContacts`)            | Every 2 Hours    |
| **Phase**     | **Phase 1: Accounts / Contacts & Affiliates** |
| **Language**  | Node.js (ES6+)                                | Standard         |

---

## 1. Project Objective

This project is a critical incremental synchronization job designed to maintain data parity between the **Galaxy ERP System** (source of truth) and the **Zoho CRM Accounts Module**.

The primary architectural achievement is the robust handling of the complex **Affiliate** to **Customer Account** relationship, which is dynamically resolved during the ETL process.

### 1.1 Core ETL Flow

1.  **Watermark Retrieval:** Fetch the highest `Rev_Number` (High Watermark) from the Zoho Accounts module.

2.  **Galaxy Fetch (Accounts):** Retrieve all Customer Accounts (`zh_Customers_fin`) with a revision number **greater** than the High Watermark.

3.  **Galaxy Fetch (Affiliates):** Determine the minimum required `Rev_Number` from the fetched customer batch and retrieve all relevant Affiliates (`ZH_AFFILIATE`).

4.  **Upsert Affiliates:** Upsert Affiliates (deduplicated by `Trader_ID`) into Zoho Accounts. Create a lookup map of `Customer_Rev_Number` to `Affiliate_Zoho_ID`.

5.  **Upsert Accounts:** Upsert Customer Accounts (keyed by `Trader_ID`). Attach the Zoho ID lookup from Step 4 to the `Affiliate_To` field based on matching `Rev_Number`.

---

## 2. Technical Stack and Structure

The codebase is highly modular, focusing on clear separation of concerns, performance, and resilience.

### 2.1 Directory Structure

├── auth/

│ ├── auth.js # Galaxy Auth logic (SessionId/ss-pid handling)

│ └── zohoAuth.js # Zoho OAuth token management (Refresh Token flow)

├── accounts/

│ ├── fetchAccountsZoho.js # Galaxy Customer Account Fetch logic

│ ├── fetchAffiliates.js # Galaxy Affiliate Fetch logic

│ ├── pushAccountsZoho.js # Zoho Accounts Upsert & Watermarking

│ └── pushAffiliatesZoho.js # Zoho Affiliates Upsert

├── contacts/

│ └── // TODO

├── utils/

│ ├── filters.js # Utility for building Galaxy filter strings

│ └── sessionStore.js # Persistence for Galaxy session keys

├── api/

│ └── apiClient.js # Configures the Axios client for Galaxy

└── index.js # **Job Orchestrator (Main Entry Point)**

### 2.2 Key Technologies & Optimizations

| Area                 | Component         | Description & Optimization                                                                                                                          |
| :------------------- | :---------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data Integrity**   | Watermarking      | Uses `getMaxZohoRevNumber` to find the highest `Rev_Number` in Zoho, ensuring the job is always incremental and only processes new/changed records. |
| **Performance**      | HTTP Keep-Alive   | Axios is configured with `https.Agent({ keepAlive: true })` for both Zoho and Galaxy, reducing TCP/TLS handshake latency on batch operations.       |
| **API Efficiency**   | Zoho Batching     | All Zoho upserts use the maximum batch size of **100 records** (`BATCH_SIZE=100`) to minimize API call count.                                       |
| **Resilience**       | Re-authentication | Logic in `index.js` automatically detects Galaxy session expiry (401/403), re-authenticates via `auth.js`, and retries the failed fetch operation.  |
| **Relational Logic** | `index.js`        | Uses **JavaScript `Set`** objects (`batchRevNumSet`) for near $O(1)$ lookup time when resolving Affiliates to Customer Accounts.                    |

---

## 3. Deployment and Configuration

### 3.1 Environment Variables (Required)

All sensitive configuration data must be managed via the Zoho Catalyst Environment Variables console.

| Variable                 | Target Service | Purpose                              | Sensitivity  |
| :----------------------- | :------------- | :----------------------------------- | :----------- |
| **`BASE_URL`**           | Galaxy ERP     | Base URL for the Galaxy API.         | High         |
| **`username`**           | Galaxy ERP     | Service account username for Galaxy. | High         |
| **`password`**           | Galaxy ERP     | Service account password.            | **CRITICAL** |
| **`ZOHO_CLIENT_ID`**     | Zoho CRM       | OAuth Client ID.                     | High         |
| **`ZOHO_CLIENT_SECRET`** | Zoho CRM       | OAuth Client Secret.                 | High         |
| **`ZOHO_REFRESH_TOKEN`** | Zoho CRM       | Long-lived refresh token for access. | **CRITICAL** |
| **`ZOHO_DC`**            | Zoho CRM       | Data Center (e.g., `eu`, `us`).      | Low          |

### 3.2 Running & Debugging Locally (Developer Console)

The job supports local debugging by setting the following flags:

| Flag            | Purpose                                                                                                                               | Example Value  | Notes                                                          |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------ | :------------- | :------------------------------------------------------------- |
| **`DEBUG`**     | Activates verbose logging across all modules (`apiClient.js`, `push*Zoho.js`). Displays full request URLs, headers, and data samples. | `DEBUG=1`      | Essential for tracing data transformation issues.              |
| **`DEV_LIMIT`** | Restricts the number of **Customer Accounts** processed in the main loop, allowing quick end-to-end testing with a smaller dataset.   | `DEV_LIMIT=50` | Use this to avoid processing large batches during development. |

---

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

---

For any questions, issues, or proposed architectural changes, please contact the repository owner: Sakis Oikonomou (ath.oikonomou@hotmail.com).
