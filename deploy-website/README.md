# Deploy Website

> A self-hosted website deployment platform with a responsive dashboard, project management, deployment workflow, authentication, and optional MongoDB persistence.

Deploy Website is designed as a practical foundation for developers who want to run their own lightweight deployment service instead of depending entirely on a third-party hosting dashboard.

## ✨ Features

- **Responsive dashboard** — desktop and mobile layouts
- **Authentication** — registration, login, email verification, password reset
- **Project management** — create and manage deployment projects
- **Website deployments** — upload a project archive and publish it
- **Deployment history** — track releases and deployment activity
- **Admin workspace** — manage users, projects, settings, and reports
- **Local persistence** — JSON storage for simple/self-hosted setups
- **Optional MongoDB** — use MongoDB for persistent database storage
- **Email integration** — optional transactional email support through Resend
- **Cloudflare Tunnel ready** — example configuration included
- **Security-minded defaults** — HTTP hardening, sessions, upload limits, and environment-based configuration
- **Custom branding** — replace the included logo, account image, and favicon

## 🧱 Stack

- Node.js 20+
- Express 5
- MongoDB driver 6
- Multer
- Adm-Zip
- Vanilla JavaScript
- HTML/CSS
- Optional Cloudflare Tunnel
- Optional Resend email delivery

## 📁 Project structure

```text
deploy-website/
├── cloudflared/
│   └── config.example.yml
├── public/
│   ├── branding/
│   ├── badges/
│   ├── ui/
│   ├── app.js
│   └── index.html
├── scripts/
│   ├── bootstrap-admin.js
│   ├── check-admin.js
│   ├── diagnose-cloud.js
│   ├── reset-admin.js
│   └── ...
├── server/
│   ├── mongodb.js
│   └── server.js
├── storage/
│   └── data/
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## 🚀 Quick start

### 1. Requirements

Install:

- Node.js 20 or newer
- npm
- MongoDB only if you want external database persistence
- Cloudflare Tunnel only if you want public access through Cloudflare

### 2. Install dependencies

```bash
npm install
```

### 3. Create your environment file

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Then edit the values for your own environment.

**Never commit `.env` to Git.**

### 4. Create an administrator

Run:

```bash
npm run bootstrap-admin
```

The script asks for the administrator email and password interactively.

### 5. Start the server

```bash
npm start
```

Open:

```text
http://127.0.0.1:3000
```

## 🔐 Configuration

The main environment variables are:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port |
| `HOST` | Bind address |
| `BCLOUD_DOMAIN` | Public deployment domain |
| `BCLOUD_HOST` | Dashboard hostname |
| `ADMIN_EMAIL` | Default admin/support address |
| `RESEND_API_KEY` | Optional email provider key |
| `EMAIL_FROM` | Sender identity |
| `MONGODB_URI` | Optional MongoDB connection string |
| `MAX_UPLOAD_MB` | Upload size limit |
| `MAX_FILES` | Maximum files per archive |
| `MAX_UNZIPPED_MB` | Uncompressed archive limit |
| `SESSION_HOURS` | Session lifetime |

See `.env.example` for the complete configuration template.

## 🌐 Cloudflare Tunnel

A sanitized example is available at:

```text
cloudflared/config.example.yml
```

Replace the placeholders with your own:

- Cloudflare tunnel ID
- credentials file
- dashboard domain
- deployment domain

Do **not** commit your real Cloudflare credentials.

## 📧 Email

Email functionality is optional.

If email is enabled, configure:

```env
RESEND_API_KEY=your_key
EMAIL_FROM=Deploy Website <hello@example.com>
```

Use a sender domain that you own and have verified with your email provider.

## 🗄️ Storage

For a simple installation, the application can use its local JSON database.

For a more durable setup, configure MongoDB:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/deploy_website
```

Runtime data is intentionally excluded from Git.

## 🛠️ Useful commands

```bash
npm start
npm run bootstrap-admin
npm run reset-admin
npm run check-admin -- admin@example.com
npm run diagnose-cloud
```

## 🔒 Security notes

Before exposing the service to the public internet:

1. Use HTTPS.
2. Set a strong administrator password.
3. Configure a real `ADMIN_EMAIL`.
4. Keep `.env` private.
5. Never commit database dumps.
6. Never commit Cloudflare credential files.
7. Use a secure MongoDB deployment if MongoDB is enabled.
8. Review upload and archive limits for your environment.
9. Keep Node.js and dependencies updated.
10. Put the application behind a trusted reverse proxy or Cloudflare Tunnel for public deployments.

This repository is intended as a self-hosted foundation. Review and harden the deployment for your own threat model before using it for sensitive or production workloads.

## 🧩 Customization

You can replace the branding assets in:

```text
public/branding/
public/badges/
public/ui/
```

You can also customize the UI in:

```text
public/index.html
public/app.js
```

The backend entry point is:

```text
server/server.js
```

## 🤝 Contributing

Contributions are welcome.

A simple workflow:

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Test the application locally.
5. Open a pull request with a clear description.

## 📄 License

MIT License.

See `LICENSE` for the full license text.

## ⚠️ Disclaimer

This project is provided as an open-source/self-hosted software foundation. You are responsible for configuring authentication, domains, email delivery, databases, infrastructure, backups, monitoring, and security appropriately for your environment.
