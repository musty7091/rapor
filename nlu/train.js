// nlu/train.js — Regex'siz sağlam eğitim
const { dockStart } = require('@nlpjs/basic');
const fs = require('fs');
const path = require('path');

(async () => {
  const dock = await dockStart({
    settings: { nlp: { languages: ['tr'] } },
    use: ['Basic', 'LangTr']
  });
  const nlp = dock.get('nlp');

  // 1) Intentler
  const intents = JSON.parse(fs.readFileSync(path.join(__dirname, 'intents.tr.json'), 'utf8'));
  for (const item of intents.data) {
    for (const utt of item.utterances) {
      await nlp.addDocument('tr', utt, item.intent);
    }
  }

  // 2) Entity'ler — SADECE SÖZLÜKLER (regex YOK)
  const entities = JSON.parse(fs.readFileSync(path.join(__dirname, 'entities.tr.json'), 'utf8'));
  for (const d of (entities.dictionaries || [])) {
    for (const [key, val] of d.pairs) {
      await nlp.addNerRuleOptionTexts('tr', d.name, val, [key]);
    }
  }

  await nlp.train();

  const modelPath = path.join(__dirname, '..', 'models', 'nlp.model.nlp');
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  nlp.save(modelPath);
  console.log('✅ NLU modeli kaydedildi:', modelPath);
})();
