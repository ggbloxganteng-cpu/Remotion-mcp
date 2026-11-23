# remotion-render-mcp

MCP server (stdio) untuk **render penuh** proyek Remotion — semua frame + audio ke file final (mp4/webm/mov/gif/mp3/wav), bukan hanya preview.

## Instalasi

```bash
cd remotion-render-mcp
npm install
npm run build
```

> **Penting:** versi `@remotion/bundler` dan `@remotion/renderer` harus **sama persis** dengan versi `remotion` di proyek yang mau dirender. Ubah `^4.0.0` di `package.json` ke versi proyekmu (mis. `4.0.350`), lalu `npm install` lagi.
>
> Proyek Remotion target juga harus sudah `npm install` (server ini memakai `node_modules` proyek untuk bundling).

## Daftarkan ke klien MCP

Salin `mcp.config.example.json` ke konfigurasi klien (Claude Desktop: `claude_desktop_config.json`), ganti path:

```json
{
  "mcpServers": {
    "remotion-render": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/remotion-render-mcp/dist/index.js"],
      "env": {
        "REMOTION_MCP_ALLOWED_ROOTS": "/ABSOLUTE/PATH/ke/folder-proyek-remotion",
        "REMOTION_GL": "angle"
      }
    }
  }
}
```

Untuk Claude Code:

```bash
claude mcp add remotion-render -e REMOTION_MCP_ALLOWED_ROOTS=/path/proyek -- node /ABSOLUTE/PATH/remotion-render-mcp/dist/index.js
```

Uji dengan Inspector: `npm run inspect`.

## Environment variable

| Variable | Fungsi |
|---|---|
| `REMOTION_MCP_ALLOWED_ROOTS` | Batasi folder yang boleh dibaca/ditulis (pisah dengan `:` di Linux/macOS, `;` di Windows). Sangat disarankan. |
| `REMOTION_GL` | Backend GL Chromium: `angle`, `egl`, `swiftshader`, `swangle`, `vulkan`, `angle-egl`. Berguna di server/Docker tanpa GPU. |
| `REMOTION_BROWSER_EXECUTABLE` | Pakai Chrome/Chromium sendiri (lewati unduhan otomatis). |

## Tools

| Tool | Fungsi |
|---|---|
| `list_compositions` | Daftar composition: id, resolusi, fps, durasi. |
| `render_video` | Render **satu** composition penuh. |
| `render_all` | Render **semua** composition (atau daftar tertentu) ke satu folder. |
| `render_still` | Render satu frame jadi PNG/JPEG. |
| `get_render_status` | Cek progres job berdasarkan `jobId`. |
| `list_render_jobs` | Daftar semua job. |
| `cancel_render` | Batalkan job. |

Render berjalan sebagai **job** dengan antrian satu-per-satu. Dua mode:

- `wait: false` (default) → langsung dapat `jobId`; cek dengan `get_render_status`. Aman untuk render panjang yang bisa kena timeout klien.
- `wait: true` → menunggu sampai selesai; progres dikirim lewat notifikasi MCP kalau klien mendukung.

Opsi render: `codec`, `crf`, `concurrency`, `scale`, `imageFormat`, `muted`, `videoBitrate`, `audioBitrate`, `props` (inputProps), `startFrame`/`endFrame` (render sebagian), `overwrite`, `timeoutInMilliseconds`.

Bundle di-cache dan otomatis dibuat ulang saat file proyek berubah (`rebundle: true` untuk memaksa).

## Contoh prompt

- "Pakai remotion-render, tampilkan composition di `/Users/aku/video-promo`."
- "Render composition `Promo` di `/Users/aku/video-promo` full ke mp4 CRF 18, tunggu sampai selesai."
- "Render semua composition di proyek itu ke folder `out/final` sebagai h264, lalu cek statusnya."
- "Render `Intro` sebagai webm transparan (vp9, imageFormat png)."

Output default ada di `<proyek>/out/<compositionId>.<ext>`.

## Deploy remote (Railway) — mode HTTP

Kalau env `PORT` ada (Railway otomatis mengisinya) atau `MCP_TRANSPORT=http`, server berjalan sebagai **Streamable HTTP** di endpoint `/mcp`. Tanpa itu, server berjalan sebagai stdio (lokal).

1. **Taruh proyek Remotion di server.** Salin proyekmu ke `projects/<nama>/` di repo ini (beserta `package.json`). `Dockerfile` akan menjalankan `npm install` untuk tiap proyek. Di Railway, `projectPath` yang dipakai tool adalah path di server, mis. `/app/projects/<nama>`.
2. **Push ke Railway.** Karena ada `Dockerfile`, Railway memakainya otomatis (butuh library sistem untuk Chromium).
3. **Set Variables di Railway:**
   - `MCP_AUTH_TOKEN` = string acak panjang (**wajib**; tanpa ini server menolak start)
   - `REMOTION_MCP_ALLOWED_ROOTS` = `/app/projects` (opsional, itu defaultnya)
4. **Buat domain publik:** Service → Settings → Networking → *Generate Domain*.
5. **URL MCP-nya:**

   ```
   https://<domain-kamu>.up.railway.app/mcp
   ```

   Autentikasi: header `Authorization: Bearer <MCP_AUTH_TOKEN>`, atau untuk klien yang hanya menerima URL, tambahkan token di query: `https://<domain>/mcp?token=<MCP_AUTH_TOKEN>`.

   Claude Code:

   ```bash
   claude mcp add --transport http remotion-render https://<domain>.up.railway.app/mcp \
     --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
   ```

6. **Cek hidup:** buka `https://<domain>/health` → harus tampil `remotion-render-mcp ok`.

Catatan penting untuk mode remote:

- Hasil render tersimpan di disk server. Tool mengembalikan `downloadUrl` (link acak `/d/<kunci>`) untuk mengunduh file. Disk Railway **ephemeral** (hilang saat redeploy); pasang Volume kalau butuh file bertahan, lalu arahkan `outputDir` ke path volume (dan masukkan ke `REMOTION_MCP_ALLOWED_ROOTS`).
- Pakai `wait: false` (default) untuk render panjang, lalu cek `get_render_status`. Request HTTP yang menunggu lama bisa diputus proxy.
- Render butuh RAM/CPU besar; kalau crash/OOM, naikkan resource service atau turunkan `concurrency` dan `scale`.
- Mode HTTP stateless: tiap request membuat server baru, tapi daftar job tetap hidup selama proses jalan (hilang saat restart).

## Troubleshooting

- **`Dependency proyek belum terpasang`** → jalankan `npm install` di proyek Remotion.
- **Error versi tidak cocok** → samakan versi `@remotion/*` di server ini dengan `remotion` di proyek.
- **Render lambat / hang di server tanpa GPU** → set `REMOTION_GL=angle` dan turunkan `concurrency`.
- **Timeout per frame** → naikkan `timeoutInMilliseconds` (komposisi yang memuat aset berat).
- **Output korup di klien MCP** → jangan tambah `console.log` ke kode; stdout dipakai protokol (di sini sudah dialihkan ke stderr).
- Render audio/video butuh `ffmpeg`; Remotion v4 membawanya sendiri, tidak perlu instal manual.
