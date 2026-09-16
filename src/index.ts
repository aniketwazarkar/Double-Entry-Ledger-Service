import 'dotenv/config';
import { app } from './api/app';

const PORT = Number(process.env.PORT ?? 3000);

app.listen(PORT, () => {
  console.log(`Ledger service listening on port http://localhost:${PORT}`);
});
