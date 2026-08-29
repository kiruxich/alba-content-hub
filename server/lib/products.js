// Server-side mirror of the product id/title list that lives in the frontend
// (public/js/app.js productsData) - kept minimal since the Researcher only
// needs to know which product_ids to compute embeddings for against
// project_info.about text.
export const PRODUCTS = [
    { id: 'insights', title: 'InSights' },
    { id: 'hranitel', title: 'Хранитель' },
    { id: 'duet', title: 'ДУЭТ' },
    { id: 'crista', title: 'Crista' },
    { id: 'fantaziya', title: 'Фантазия' },
    { id: 'legitagent', title: 'legitAgent' },
    { id: 'alba-creation', title: 'Alba Creation' },
];
