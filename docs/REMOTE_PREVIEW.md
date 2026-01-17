# Remote Preview - CORS Configuration

The SuperNavi Cloud preview viewer loads tiles directly from Wasabi (S3-compatible storage) using signed URLs. For this to work in a browser, Wasabi must be configured with proper CORS headers.

## Why CORS is Required

When the browser loads tiles:
1. The viewer is served from `http://localhost:3002` (or your domain)
2. Tiles are fetched from `https://<bucket>.s3.<region>.wasabisys.com`
3. This is a cross-origin request, which browsers block by default
4. Wasabi must explicitly allow requests from your origin

**Without CORS**: The browser blocks tile responses even if the signed URL is valid. The viewer shows a black screen and console shows CORS errors.

## Wasabi CORS Configuration

### Using Wasabi Console

1. Go to Wasabi Console > Buckets > Your Bucket > Settings > CORS
2. Add a CORS rule with the following settings:

### CORS Rule (JSON)

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": [
        "http://localhost:3002",
        "https://your-production-domain.com"
      ],
      "AllowedMethods": [
        "GET",
        "HEAD"
      ],
      "AllowedHeaders": [
        "*"
      ],
      "ExposeHeaders": [
        "ETag",
        "Content-Length",
        "Content-Range",
        "Accept-Ranges"
      ],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

### Using AWS CLI (Wasabi-compatible)

Create a file `cors.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://localhost:3002", "https://your-domain.com"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

Apply it:

```bash
aws s3api put-bucket-cors \
  --bucket your-bucket-name \
  --cors-configuration file://cors.json \
  --endpoint-url https://s3.wasabisys.com
```

## Configuration Details

| Setting | Value | Purpose |
|---------|-------|---------|
| `AllowedOrigins` | Your domain(s) | Which origins can make requests |
| `AllowedMethods` | `GET`, `HEAD` | Read-only access for tiles |
| `AllowedHeaders` | `*` | Allow all request headers |
| `ExposeHeaders` | Various | Headers the browser can read from response |
| `MaxAgeSeconds` | `3000` | Cache preflight for 50 minutes |

## Troubleshooting

### Symptoms of Missing CORS

1. Viewer shows black screen
2. Browser console shows:
   - `Access to fetch has been blocked by CORS policy`
   - `No 'Access-Control-Allow-Origin' header`
3. Network tab shows tiles as `(blocked:cors)` or status 0

### Debugging Steps

1. Open browser DevTools > Network tab
2. Load a slide in the viewer
3. Look for tile requests to `*.wasabisys.com`
4. Check Response Headers for `Access-Control-Allow-Origin`

If missing, CORS is not configured on the bucket.

### Verify CORS is Working

```bash
curl -I -H "Origin: http://localhost:3002" \
  "https://your-bucket.s3.us-east-1.wasabisys.com/test-file.jpg"
```

Should return:
```
Access-Control-Allow-Origin: http://localhost:3002
Access-Control-Allow-Methods: GET, HEAD
```

## Security Notes

- Only add origins you control to `AllowedOrigins`
- Use `GET` and `HEAD` only (read-only)
- Signed URLs provide access control; CORS just allows the browser to receive the response
- `MaxAgeSeconds: 3000` reduces preflight requests
