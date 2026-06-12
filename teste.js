async function testar() {
  try {
    const r = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic os_v2_app_622axi7fkrgj3h2qetuawi7726fcv3rwtncu5mufgmep3dp63xnnubjdq43wtu4wlefmrrbgg6ub5w4gnviicd4ahowme4r57uvenhq'
      },
      body: JSON.stringify({
        app_id: "f6b40ba3-e554-4c9d-9f50-24e80b23ffd7",
        target_channel: "push",
        include_subscription_ids: ["48527d3b-eb08-444e-961e-83a29a8ec00d"],
        headings: { en: "Teste", pt: "Teste" },
        contents: { en: "Teste notificacao", pt: "Teste notificacao" }
      })
    });
    console.log('STATUS:', r.status);
    const txt = await r.text();
    console.log('RESPOSTA:', txt);
  } catch(e) {
    console.log('ERRO:', e.message);
  }
}

testar();