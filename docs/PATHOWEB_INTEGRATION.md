# PathoWeb Integration — Cloud

Modulo UI-Bridge que conecta o PathoWeb (LIS) ao SuperNavi via Chrome Extension. Fornece endpoints para consulta de casos, associacao de laminas, thumbnails assinados e magic links para viewer read-only.

## Arquitetura

```
Chrome Extension                    SuperNavi Cloud
  |                                   |
  |-- x-supernavi-key header -------->|  authenticateApiKey()
  |                                   |
  |  GET /cases/:caseBase/status ---->|  Prisma: slideRead + previewAsset
  |<---- readySlides + thumbUrls -----|  HMAC-signed thumb URLs
  |                                   |
  |  POST /viewer-link -------------->|  JWT magic link (5 min TTL)
  |<---- { url, token, expiresIn } ---|  viewerAuditLog
  |                                   |
  |  POST /cases/:caseBase/attach --->|  confirmedCaseLink = true
  |<---- { ok: true } ---------------|  viewerAuditLog
  |                                   |
  |  GET /thumb/:slideId?exp&sig ---->|  verifyThumbSignature (HMAC)
  |<---- 302 -> Wasabi signed URL ----|  getSignedUrlForKey()
```

## Modulos

| Arquivo | Funcao |
|---------|--------|
| `src/modules/ui-bridge/routes.ts` | Endpoints REST (6 rotas) |
| `src/modules/ui-bridge/matching.ts` | Heuristica de matching caso-lamina |
| `src/modules/ui-bridge/schemas.ts` | Validacao Zod dos payloads |
| `src/config/index.ts` | Variaveis de ambiente (Zod parse) |
| `src/sync/projections.ts` | Projecao `SlideRegistered` → `slides_read` com campos externos |
| `src/sync/schemas.ts` | Schema `SlideRegistered` aceita `external_case_*` |

## Variaveis de Ambiente

```bash
# Chave de API para a extensao Chrome (obrigatorio)
UI_BRIDGE_API_KEY=snavi-prod-bridge-key-CHANGEME

# Secret para magic links JWT
MAGIC_LINK_SECRET=your-random-secret-32-chars-minimum

# TTL do magic link (padrao: 300s = 5 min)
MAGIC_LINK_TTL_SECONDS=300

# Secret para thumbs HMAC (padrao: usa MAGIC_LINK_SECRET)
THUMB_SIGN_SECRET=optional-separate-secret

# TTL da assinatura de thumbs (padrao: 600s = 10 min)
THUMB_SIGN_TTL_SECONDS=600

# URL do frontend para construir magic links
FRONTEND_URL=https://app.supernavi.app
```

Todas validadas via Zod em `src/config/index.ts` na inicializacao.

## Endpoints

### GET `/api/ui-bridge/cases/:caseBase/status`

Consulta principal da extensao. Aceita `AP26000230` ou `pathoweb:AP26000230`.

**Auth:** `x-supernavi-key` header

**Response:**
```json
{
  "caseBase": "AP26000230",
  "externalCaseId": "pathoweb:AP26000230",
  "readySlides": [
    {
      "slideId": "abc123...",
      "label": "A2",
      "thumbUrl": "/api/ui-bridge/thumb/abc123...?exp=1738800000&sig=...",
      "width": 40000,
      "height": 30000
    }
  ],
  "processingSlides": [
    { "slideId": "def456...", "label": "B1" }
  ],
  "unconfirmedCandidates": [
    {
      "slideId": "ghi789...",
      "label": "slide.svs",
      "thumbUrl": "...",
      "score": 0.92,
      "filename": "AP26000230B1.svs",
      "createdAt": "2026-02-06T12:00:00.000Z"
    }
  ],
  "lastUpdated": "2026-02-06T12:00:00.000Z"
}
```

**Logica:**
1. Busca `slideRead` com `externalCaseBase` + `confirmedCaseLink: true`
2. Separa em `readySlides` (tem preview) e `processingSlides` (sem preview)
3. Busca candidatos nao-confirmados das ultimas 24h com score >= 0.85

### GET `/api/ui-bridge/cases/:caseBase/unassigned?hours=24`

Lista laminas recentes sem caso confirmado que podem ser candidatas.

**Auth:** `x-supernavi-key` header

**Query:** `hours` (1-168, padrao 24)

### POST `/api/ui-bridge/cases/:caseBase/attach`

Associa uma lamina a um caso. Marca `confirmedCaseLink: true`.

**Auth:** `x-supernavi-key` header

**Body:** `{ "slideId": "abc123..." }`

**Response:** `{ "ok": true, "slideId": "abc123...", "caseBase": "AP26000230", "externalCaseId": "pathoweb:AP26000230" }`

Registra em `viewerAuditLog` com action `case_attached`.

### POST `/api/ui-bridge/viewer-link`

Gera magic link JWT para visualizar uma lamina sem login.

**Auth:** `x-supernavi-key` header

**Body:** `{ "slideId": "abc123...", "externalCaseId": "pathoweb:AP26000230" }`

**Response:**
```json
{
  "url": "https://app.supernavi.app/viewer?slideId=abc123...&t=eyJ...",
  "token": "eyJ...",
  "expiresIn": 300
}
```

**JWT payload:**
```json
{
  "sub": "magic-link",
  "slideId": "abc123...",
  "caseId": "case-uuid",
  "externalCaseId": "pathoweb:AP26000230",
  "purpose": "viewer",
  "readOnly": true
}
```

Registra em `viewerAuditLog` com action `magic_link_created`.

### GET `/api/ui-bridge/thumb/:slideId?exp=EPOCH&sig=HEX`

Thumbnail assinado via HMAC — sem header de auth para funcionar em `<img src>`.

**Auth:** HMAC-SHA256 na query string (nao usa header)

**Response:** `302` redirect para URL assinada do Wasabi S3 (TTL 120s).

**Headers de cache:** `Cache-Control: private, max-age=300`

## Matching de Caso-Lamina

`src/modules/ui-bridge/matching.ts`

| Score | Condicao |
|-------|----------|
| **1.00** | `externalCaseBase` identico (link deterministico do filename parser) |
| **0.95** | Filename (normalizado) comeca com o caseBase completo |
| **0.92** | Digitos do filename comecam com digitos do caseBase (sem prefixo AP) |
| **0.88** | Match com tolerancia OCR (O↔0, I↔1) |
| **< 0.85** | Descartado |

Normalizacao: uppercase, remove separadores (`-`, `_`, `.`, espaco).

## Seguranca

| Mecanismo | Implementacao |
|-----------|---------------|
| API Key | `authenticateApiKey()` compara `x-supernavi-key` header |
| HMAC Thumbs | `signThumbUrl()` / `verifyThumbSignature()` com `crypto.createHmac('sha256')` |
| Timing-safe | `crypto.timingSafeEqual` na verificacao HMAC (previne timing attacks) |
| Magic Link JWT | `jsonwebtoken.sign()` com claims bind (`slideId`, `purpose`, `readOnly`) |
| Audit Log | Toda acao grava em `viewerAuditLog` (IP, user-agent, metadata) |
| Thumb expiracao | `exp` em epoch seconds, rejeitado se expirado |

## Schema Prisma (campos adicionados)

```prisma
model SlideRead {
  // ... campos existentes ...
  externalCaseId      String?
  externalCaseBase    String?
  externalSlideLabel  String?
  confirmedCaseLink   Boolean  @default(false)
  hasPreview          Boolean  @default(false)
}

model ViewerAuditLog {
  id              String   @id @default(uuid())
  slideId         String
  externalCaseId  String?
  action          String   // magic_link_created, case_attached
  ipAddress       String?
  userAgent       String?
  metadata        Json?
  createdAt       DateTime @default(now())
}
```

Migration: `prisma/migrations/20260209191813_add_pathoweb_integration/`

## Teste rapido

```bash
# Status de um caso
curl -s -H 'x-supernavi-key: snavi-dev-bridge-key-2026' \
  http://localhost:3001/api/ui-bridge/cases/AP26000230/status | jq .

# Gerar magic link
curl -s -X POST -H 'x-supernavi-key: snavi-dev-bridge-key-2026' \
  -H 'Content-Type: application/json' \
  -d '{"slideId":"SLIDE_ID"}' \
  http://localhost:3001/api/ui-bridge/viewer-link | jq .

# Associar lamina a caso
curl -s -X POST -H 'x-supernavi-key: snavi-dev-bridge-key-2026' \
  -H 'Content-Type: application/json' \
  -d '{"slideId":"SLIDE_ID"}' \
  http://localhost:3001/api/ui-bridge/cases/AP26000230/attach | jq .

# Verificar thumb (copie thumbUrl do status response)
curl -sI 'http://localhost:3001/api/ui-bridge/thumb/SLIDE_ID?exp=...&sig=...'
# Expect: 302 Location: https://s3...wasabisys.com/...
```
