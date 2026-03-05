// routes/locationRoutes.js
router.get('/states', async (req, res) => {
  const states = await db.selectFrom('dbo.states')
    .select(['id', 'name'])
    .orderBy('name')
    .execute();
  res.json({ states });
});

router.get('/cities/:stateId', async (req, res) => {
  const cities = await db.selectFrom('dbo.cities')
    .select(['id', 'name'])
    .where('state_id', '=', parseInt(req.params.stateId))
    .orderBy('name')
    .execute();
  res.json({ cities });
});