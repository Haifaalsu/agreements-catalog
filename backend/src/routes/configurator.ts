import { Router } from 'express';
import { pool } from '../db/pool';
import { getConfiguratorDimensions, resolveConfiguratorStep } from '../services/configuratorService';

export const configuratorRouter = Router();

async function resolveAgreementId(slugOrId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT id FROM agreements WHERE id::text = $1 OR slug = $1`, [slugOrId]);
  return rows[0]?.id ?? null;
}

configuratorRouter.get('/:agreement/dimensions', async (req, res) => {
  const agreementId = await resolveAgreementId(req.params.agreement);
  if (!agreementId) return res.status(404).json({ error: 'الاتفاقية غير موجودة' });
  res.json(await getConfiguratorDimensions(agreementId));
});

configuratorRouter.get('/:agreement/step', async (req, res) => {
  const agreementId = await resolveAgreementId(req.params.agreement);
  if (!agreementId) return res.status(404).json({ error: 'الاتفاقية غير موجودة' });

  let selections: Record<string, string> = {};
  if (typeof req.query.selections === 'string' && req.query.selections.length > 0) {
    try {
      selections = JSON.parse(req.query.selections);
    } catch {
      return res.status(400).json({ error: 'صيغة selections غير صحيحة (يجب أن تكون JSON)' });
    }
  }

  const result = await resolveConfiguratorStep(agreementId, selections);
  res.json(result);
});
