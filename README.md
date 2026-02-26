# EnZo POS — Production-Ready Offline-First PWA
## v2.0 | Industrial Terminal Edition

---

## ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────┐
│                    EnZo POS PWA                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │  Login   │  │ Checkout │  │  Orders  │  │Reports │ │
│  │  (PIN)   │  │ (SPA)    │  │ History  │  │ Export │ │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Sync Engine (Outbox Pattern)           │   │
│  │  push() ◄─────────────────────────► pull()      │   │
│  └───────────┬──────────────┬───────────────────────┘   │
│  ┌───────────▼──┐  ┌────────▼───┐  ┌──────────────┐    │
│  │   Dexie      │  │  Service   │  │  Connectors  │    │
│  │  IndexedDB   │  │  Worker    │  │  (pluggable) │    │
│  └──────────────┘  └────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────┘
                           │ sync
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌──────────┐   ┌──────────────┐  ┌──────────────┐
    │  Frappe  │   │  Node-RED    │  │  Custom REST │
    │ ERPNext  │   │  Backend     │  │  (Express+   │
    │ v15+     │   │  (Proxy/DB)  │  │   SQLite)    │
    └──────────┘   └──────────────┘  └──────────────┘
```

---

## QUICK START

### Option 1: Static Deploy (Simplest)
```bash
# Serve the PWA directly
cd pos-pwa
python3 -m http.server 8080
# or
npx serve .
```
Open: http://localhost:8080

**Demo credentials:**
| Role       | PIN  |
|------------|------|
| Admin      | 1234 |
| Cashier 1  | 1111 |
| Supervisor | 9999 |

### Option 2: Docker (Recommended for production)
```bash
docker-compose up -d
```
- Frontend: http://localhost:80
- Backend API: http://localhost:3000
- Health: http://localhost:3000/health

### Option 3: Raspberry Pi Deployment
```bash
# Install nginx
sudo apt update && sudo apt install nginx -y

# Copy PWA files
sudo cp -r pos-pwa/* /var/www/html/

# Nginx config
sudo cp nginx.conf /etc/nginx/nginx.conf
sudo systemctl restart nginx

# Auto-start on boot
sudo systemctl enable nginx
```

---

## DATA MODEL

### IndexedDB Tables (Dexie)

| Table               | Purpose                           | Key Fields                        |
|--------------------|-----------------------------------|-----------------------------------|
| settings           | App configuration (key-value)     | key                               |
| users              | Operator accounts (offline auth)  | uuid, username, role, pin_hash    |
| products           | Product catalog (cached)          | uuid, sku, barcode, category      |
| categories         | Product categories                | uuid, name                        |
| orders             | Sales orders                      | uuid, shift_id, sync_status       |
| order_items        | Line items per order              | uuid, order_uuid                  |
| payments           | Payment records per order         | uuid, order_uuid, method          |
| refunds            | Refund records                    | uuid, order_uuid, reason          |
| inventory_movements| Stock movement ledger             | uuid, product_uuid, type          |
| shifts             | Shift sessions                    | uuid, status, opened_at           |
| cash_events        | Cash in/out per shift             | uuid, shift_id, type              |
| sync_outbox        | Pending sync queue (CRITICAL)     | id, entity_type, sync_status      |
| sync_state         | Sync timestamps & metadata        | key                               |

### Every Record Contains:
- `uuid` — client-generated UUID
- `device_id` — terminal device identifier
- `created_at_local` — ISO timestamp (client clock)
- `sync_status` — pending | synced | failed

---

## SYNC ARCHITECTURE

### Outbox Pattern Flow:
```
User Action → Local DB Write → sync_outbox entry
                                      │
                    ┌─────────────────┘
                    ▼ (on: timer / online / manual)
              SyncEngine.sync()
                    │
              connector.healthCheck()
                    │
              connector.push(batch)  ──► Server (idempotent by UUID)
                    │
              connector.pull(since)  ◄── Server catalog updates
```

### Conflict Resolution:
| Entity Type | Strategy | Rationale |
|------------|----------|-----------|
| Orders | **Client wins** | Orders are immutable once created |
| Catalog | **Server wins** | Server is catalog source of truth |
| Inventory | **Ledger merge** | Server recomputes from movements |
| Refunds | **Client wins** | Processed locally, accepted by server |
| Shifts | **Client wins** | Terminal owns its shift data |

### Retry Strategy:
- Failed items retry with **exponential backoff**: 1min → 2min → 4min → 8min (max)
- Failed items can be exported as CSV for manual processing
- Admin can view failed items with error details in Settings

---

## CONNECTORS

### Connector 1: Frappe/ERPNext

**Setup:**
```bash
cd frappe-bench
bench get-app pos_sync ./server-examples/frappe
bench install-app pos_sync --site yoursite.local
bench restart
```

**Config in Admin Settings:**
```
Base URL:    https://erp.yourcompany.com
Auth Method: API Key/Secret
API Key:     [your_api_key]
API Secret:  [your_api_secret]
```

**Endpoints:**
- `POST /api/method/pos_sync.push_batch`
- `GET  /api/method/pos_sync.pull_catalog?since=...`
- `GET  /api/method/pos_sync.health`

### Connector 2: Node-RED

**Import flow:**
1. Open Node-RED → Menu → Import
2. Select `server-examples/nodered/pos-sync-flow.json`
3. Set environment variable: `POS_TOKEN=your-secret-token`
4. Deploy

**Config in Admin Settings:**
```
Node-RED URL:   http://your-nodered:1880
Bearer Token:   your-secret-token
```

**Persistence:** Set `contextStorage.default.module = 'localfilesystem'` in settings.js for data persistence across restarts.

### Connector 3: Custom REST

**Setup:**
```bash
cd server-examples/rest
npm install
cp .env.example .env    # Set API_TOKEN
node server.js
```

**Seed catalog:**
```bash
curl -X POST http://localhost:3000/admin/catalog/products \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"products": [{"uuid":"prod-001","name":"Coffee","price":3.50,"category":"cat-001","active":1}]}'
```

---

## ROLES & PERMISSIONS

| Action        | Cashier | Supervisor | Admin |
|--------------|---------|------------|-------|
| POS Checkout  | ✓       | ✓          | ✓     |
| Orders View   | ✓       | ✓          | ✓     |
| Shift Open/Close | ✓    | ✓          | ✓     |
| Reports       | ✗       | ✓          | ✓     |
| Settings      | ✗       | ✗          | ✓     |
| Void Orders   | ✗       | ✓          | ✓     |
| Apply Discounts | ✗     | ✓          | ✓     |
| Process Refunds | ✗     | ✓          | ✓     |

---

## PAYMENT METHODS

| Method  | Change Calc | Notes                       |
|---------|-------------|----------------------------|
| Cash    | ✓ Auto      | Numpad tendered input       |
| Card    | ✗           | Awaiting terminal message   |
| EFT     | ✗           | Bank transfer               |
| Mobile  | ✗           | Mobile money / QR           |
| Split   | ✓ Partial   | Multiple methods per order  |

---

## RECEIPT NUMBERING

1. **Local provisional**: `ORD-[timestamp_last6]` — used offline
2. **Server-confirmed**: `RCP-YYYY-NNNNN` — assigned on successful sync
3. Receipts reference the client UUID for traceability

---

## BARCODE SCANNER SUPPORT

- **Keyboard wedge scanners**: Automatically captured via `keydown` event listener
  - Triggers: rapid key input <100ms between chars, terminated by Enter
- **Camera scan**: Click the 📷 button (requires HTTPS for camera access)
- **Format support**: EAN-13, UPC-A, Code-128, QR Code

---

## PWA INSTALLATION

**Android Chrome:**
1. Open in Chrome → Menu → "Add to Home Screen"

**iOS Safari:**
1. Open in Safari → Share → "Add to Home Screen"

**Desktop Chrome:**
1. Address bar → Install button (⊕)

---

## SECURITY NOTES

- PINs are hashed client-side (SHA-like; use WebCrypto PBKDF2 in production)
- API tokens stored in IndexedDB settings (not localStorage)
- HTTPS required for: camera scan, service worker, WebCrypto
- Admin settings restricted by role
- All outbox payloads include `device_id` + `terminal_id` for audit trail

---

## ENVIRONMENT VARIABLES (REST Backend)

```env
PORT=3000
API_TOKEN=your-very-secret-token-change-me
DATA_DIR=./data
```

---

## TEST PLAN

### Offline Tests:
1. Load app → disable network → complete full sale → verify saved in IndexedDB
2. Close browser mid-transaction → reopen → verify data intact
3. Process refund while offline → verify outbox entry created

### Sync Tests:
1. Go online → verify outbox items push to backend
2. Send duplicate UUID → verify idempotent (no duplicate created)
3. Disconnect mid-sync → verify retry logic with backoff

### Performance Tests:
1. Load 500+ products → verify grid renders under 500ms
2. Create 100 orders → verify orders list paginates
3. Close shift with 1000 transactions → verify report accuracy
