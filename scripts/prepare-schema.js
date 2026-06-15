import fs from 'fs';

const url = process.env.DATABASE_URL || '';
if (url.startsWith('postgresql') || url.startsWith('postgres')) {
  const schemaPath = 'prisma/schema.prisma';
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const updated = schema.replace('provider = "sqlite"', 'provider = "postgresql"');
  fs.writeFileSync(schemaPath, updated);
  console.log('Schema provider switched to postgresql');
}
