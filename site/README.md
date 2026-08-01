<div align="center">

# Product Control Tower demo

### The public, read-only face of Open Product Operations OS.

</div>

---

This site uses fictional PineDesk-style data to demonstrate the product-owner experience. It never
connects to a generated project's local runtime, approval store, credentials, providers, or write
authority.

| Surface | Data | Writes |
| --- | --- | --- |
| Public demo | Fictional records bundled with the site | Never |
| Local dashboard | Current generated project | Read-only by default |
| Local authorized dashboard | Current generated project | Intake, attributed decisions, and bounded scheduler cycles |

## Local site development

```text
npm install
npm run dev
npm run build
npm test
```

For the authoritative runtime contract, see [`../docs/runtime/README.md`](../docs/runtime/README.md).
