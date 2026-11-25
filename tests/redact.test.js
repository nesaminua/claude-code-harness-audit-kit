'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { redact, truncate, projectLabel } = require('../scripts/lib/redact.js');

const A = 'A'.repeat(24);
const tokens = {
  'anthropic-key': 'sk-' + 'ant-api03-' + A + '_x-y',
  'api-key': 'sk-' + 'proj_' + A,
  'stripe-key': ['sk', 'live', 'abcdefghij12'].join('_'),
  'stripe-test': ['sk', 'test', 'abcdefghij12'].join('_'),
  'stripe-restricted': ['rk', 'live', 'abcdefghij12'].join('_'),
  'github-token-p': 'gh' + 'p_' + A,
  'github-token-o': 'gh' + 'o_' + A,
  'github-token-s': 'gh' + 's_' + A,
  'github-token-u': 'gh' + 'u_' + A,
  'github-pat': 'github' + '_pat_' + A + '_1',
  'slack-token': 'xo' + 'xb-123456789-abcdefABCDEF',
  'slack-token-p': 'xo' + 'xp-123456789-abcdefABCDEF',
  'aws-key': 'AK' + 'IA' + 'ABCDEFGH12345678',
  jwt: ['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiJhbGljZSJ9', 'c2lnbmF0dXJl'].join('.'),
  'supabase-token': 'sb' + 'p_' + A,
  'supabase-secret': 'sb_' + 'secret_' + A,
  'google-key': 'AI' + 'za' + 'B'.repeat(35),
  'npm-token': 'npm' + '_' + 'a1B2'.repeat(9),
  'xai-key': 'xa' + 'i-' + A,
  'gitlab-token': 'gl' + 'pat-' + A,
};

for (const [name, tok] of Object.entries(tokens)) {
  test(`masks ${name}`, () => {
    const out = redact(`key is ${tok} here`);
    assert.ok(!out.includes(tok), out);
    assert.match(out, /^key is <redacted:[a-z-]+> here$/);
  });
}

test('private key block', () => {
  const dashes = '-'.repeat(5);
  const label = ['RSA', 'PRIVATE', 'KEY'].join(' ');
  const b = `${dashes}BEGIN ${label}${dashes}\nMIIabc\ndef==\n${dashes}END ${label}${dashes}`;
  assert.equal(redact(`x\n${b}\ny`), 'x\n<redacted:private-key>\ny');
});

test('bearer token', () => {
  assert.equal(redact('Authorization: Bearer abcDEF123456.xyz'), 'Authorization: Bearer <redacted:bearer>');
});

test('name=value keeps the name', () => {
  assert.equal(redact('password=hunter2'), 'password=<redacted:secret>');
  assert.equal(redact('API_KEY: abc123'), 'API_KEY: <redacted:secret>');
  assert.equal(redact('access-key = zzzzzz'), 'access-key = <redacted:secret>');
  assert.equal(redact('max_tokens: 5'), 'max_tokens: 5');
});

test('url credentials', () => {
  const scheme = 'postg' + 'res://';
  assert.equal(
    redact(`${scheme}alice${':'}s3cret@db.example.com:5432/x`),
    `${scheme}<redacted${':'}credentials>@db.example.com:5432/x`
  );
});

test('emails', () => {
  assert.equal(redact('mail alice@acme.example now'), 'mail <email> now');
});

test('plain words with token-like prefixes are untouched', () => {
  assert.equal(redact('task-abcdefghijklmnopqrstuvwxyz'), 'task-abcdefghijklmnopqrstuvwxyz');
});

test('home dir posix', () => {
  const o = { homedir: '/Users/alice' };
  assert.equal(redact('/Users/alice/dev/acme/a.js', o), '~/dev/acme/a.js');
  assert.equal(redact('/Users/alice', o), '~');
  assert.equal(redact('/Users/alice2/x', o), '<home>/x');
});

test('encoded home form', () => {
  assert.equal(redact('-Users-alice-dev-acme/abc.jsonl', { homedir: '/Users/alice' }), '~-dev-acme/abc.jsonl');
  assert.equal(redact('C--Users-alice-dev-acme', { homedir: 'C:\\Users\\alice' }), '~-dev-acme');
});

test('truncated and foreign encoded homes are masked', () => {
  const o = { homedir: '/Users/alice' };
  const cut = redact('f=~/.claude/projects/-Users-ali', o);
  assert.ok(!cut.includes('-Users-ali'), cut);
  assert.equal(redact('f=/x/.claude/projects/-Users-ali', o), 'f=/x/.claude/projects/<home>');
  assert.equal(redact('-Users-bob-dev-x', o), '<home>-dev-x');
  assert.equal(redact('C--Users-bob', o), '<home>');
  assert.equal(redact('-home-carol-proj', o), '<home>-proj');
  assert.equal(redact('-Users-alice-dev-acme', o), '~-dev-acme');
  assert.equal(redact('read the Users-guide first', o), 'read the Users-guide first');
});

test('encoded home cut right after the prefix', () => {
  const o = { homedir: '/Users/alice' };
  assert.equal(redact('p=/tmp/c/-Users-', o), 'p=/tmp/c/<home>');
  assert.equal(redact('p=/tmp/c/-home-', o), 'p=/tmp/c/<home>');
});

test('OS username and per-user temp roots are masked anywhere', () => {
  const o = { homedir: '/Users/alice', username: 'alice' };
  const out = redact('/var/folders/1n/abc123/T/pw-of-alice/x', o);
  assert.ok(!out.includes('alice') && !out.includes('abc123'), out);
  assert.equal(out, '<tmp>/T/pw-of-<user>/x');
  assert.equal(redact('/private/var/folders/1n/abc123/T/x', o), '<tmp>/T/x');
  assert.equal(redact('Alice and ALICE_x', o), '<user> and <user>_x');
});

test('username match is token-bounded and ignores short names', () => {
  assert.equal(redact('malice alicex', { homedir: '/Users/zed', username: 'alice' }), 'malice alicex');
  assert.equal(redact('al and AL', { homedir: '/Users/zed', username: 'al' }), 'al and AL');
  assert.equal(redact('a.b', { homedir: '/Users/zed', username: 'a.b' }), '<user>');
});

test('username defaults to the OS user without throwing', () => {
  const name = require('node:os').userInfo().username;
  if (name.length >= 3) assert.ok(!redact(`dir-of-${name}`).includes(name));
});

test('plain home path cut at end of string', () => {
  const o = { homedir: '/Users/alice' };
  assert.equal(redact('cd /Users/bo', o), 'cd <home>');
  assert.equal(redact('cd /home/ca', o), 'cd <home>');
  assert.equal(redact('cd C:\\Users\\da', o), 'cd <home>');
});

test('home dir windows, both separators', () => {
  const o = { homedir: 'C:\\Users\\alice' };
  assert.equal(redact('C:\\Users\\alice\\dev\\acme', o), '~\\dev\\acme');
  assert.equal(redact('C:/Users/alice/dev', o), '~/dev');
});

test('other users become <home>', () => {
  const o = { homedir: '/Users/alice' };
  assert.equal(redact('/Users/bob/x', o), '<home>/x');
  assert.equal(redact('/home/carol/x', o), '<home>/x');
  assert.equal(redact('C:\\Users\\dave\\x', o), '<home>\\x');
});

test('homedir defaults to os.homedir()', () => {
  const h = require('node:os').homedir();
  assert.equal(redact(h + '/x'), '~/x');
});

test('truncate', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 3), 'abc');
});

test('redact then truncate never leaks a token prefix', () => {
  const tok = tokens['anthropic-key'];
  for (let n = 1; n < 40; n++) {
    const out = truncate(redact(`${tok} tail`), n);
    assert.ok(!out.includes('sk-'), out);
    assert.ok(!out.includes('api03'), out);
  }
});

test('projectLabel', () => {
  const d = '-Users-alice-dev-acme';
  const h = crypto.createHash('sha1').update(d).digest('hex').slice(0, 6);
  assert.equal(projectLabel(d), `${h}/acme`);
});

const { PATTERNS, MAX_INPUT } = require('../scripts/lib/redact.js');
const O = { homedir: '/Users/zed', username: 'zed' };
const V = 'Zq7' + 'x9Kp2' + 'Lm4Rt8Wv'; // fictional secret value, 16 chars
const longRun = (out, value, n = 8) => {
  for (let i = 0; i + n <= value.length; i += 1) if (out.includes(value.slice(i, i + n))) return true;
  return false;
};

const shapes = {
  'PGPASSWORD env': [`PGPASSWORD=${V} psql`, `PGPASSWORD=<redacted:secret> psql`],
  'GH_TOKEN env': [`GH_TOKEN=${V}`, 'GH_TOKEN=<redacted:secret>'],
  'AWS_SECRET_ACCESS_KEY env': [`AWS_SECRET_ACCESS_KEY=${V}`, 'AWS_SECRET_ACCESS_KEY=<redacted:secret>'],
  'MY_APP_SECRET export': [`export MY_APP_SECRET=${V}`, 'export MY_APP_SECRET=<redacted:secret>'],
  'STRIPE_SECRET_KEY env': [`STRIPE_SECRET_KEY=${V}`, 'STRIPE_SECRET_KEY=<redacted:secret>'],
  'GOOGLE_API_KEY env': [`GOOGLE_API_KEY=${V}`, 'GOOGLE_API_KEY=<redacted:secret>'],
  'X_PRIVATE_KEY env': [`X_PRIVATE_KEY=${V}`, 'X_PRIVATE_KEY=<redacted:secret>'],
  'DB_CREDENTIALS env': [`DB_CREDENTIALS=${V}`, 'DB_CREDENTIALS=<redacted:secret>'],
  'double-quoted export': [`export FOO_TOKEN="${V}"`, 'export FOO_TOKEN="<redacted:secret>"'],
  'single-quoted multi-word': [`FOO_PASSWORD='${V} and more words'`, "FOO_PASSWORD='<redacted:secret>'"],
  'json multi-word password': [`{"password": "${V} two three"}`, '{"password": "<redacted:secret>"}'],
  '--password space': [`mysql --password ${V} db`, 'mysql --password <redacted:secret> db'],
  '--password=': [`tool --password=${V}`, 'tool --password=<redacted:secret>'],
  '--password= quoted': [`tool --password="${V} x y"`, 'tool --password="<redacted:secret>"'],
  '--token space': [`gh --token ${V}`, 'gh --token <redacted:secret>'],
  '--api-key space': [`tool --api-key ${V}`, 'tool --api-key <redacted:secret>'],
  '--client-secret=': [`tool --client-secret=${V}`, 'tool --client-secret=<redacted:secret>'],
  'mysql -p attached': [`mysql -u root -p${V} db`, 'mysql -u root -p<redacted:password> db'],
  'mysql -p first': [`mysql -p${V}`, 'mysql -p<redacted:password>'],
  'psql -p attached': [`psql -h x -p${V}`, 'psql -h x -p<redacted:password>'],
  'Authorization Basic': [`Authorization: Basic ${Buffer.from('alice:' + V).toString('base64')}`, 'Authorization: Basic <redacted:basic-auth>'],
  'curl header Basic': [`curl -H 'Authorization: Basic ${Buffer.from('alice:' + V).toString('base64')}' x`, "curl -H 'Authorization: Basic <redacted:basic-auth>' x"],
  'huggingface key': ['hf' + '_' + 'A1b2'.repeat(9), '<redacted:huggingface-key>'],
  'sendgrid key': ['SG' + '.' + 'aB3_'.repeat(6) + '.' + 'cD4-'.repeat(6), '<redacted:sendgrid-key>'],
  'replicate key': ['r8' + '_' + 'A1b2'.repeat(6), '<redacted:replicate-key>'],
  'stripe publishable live': ['pk' + '_live_' + 'abcdefghij12', '<redacted:stripe-key>'],
  'stripe publishable test': ['pk' + '_test_' + 'abcdefghij12', '<redacted:stripe-key>'],
  'stripe webhook secret': ['whsec' + '_' + 'A1b2'.repeat(6), '<redacted:stripe-webhook>'],
  'digitalocean token': ['dop' + '_v1_' + 'a1b2c3d4'.repeat(8), '<redacted:digitalocean-token>'],
  'shopify access token': ['shp' + 'at_' + 'a1b2c3d4'.repeat(4), '<redacted:shopify-token>'],
  'shopify shared secret': ['shp' + 'ss_' + 'a1b2c3d4'.repeat(4), '<redacted:shopify-token>'],
  'twilio sid': ['A' + 'C' + 'a1b2c3d4'.repeat(4), '<redacted:twilio-sid>'],
  'pem cut before END': ['x ' + '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIabc\n' + 'def'.repeat(40), 'x <redacted:private-key>'],
  'pem cut right after header': ['-----BEGIN ' + 'PRIVATE KEY-----', '<redacted:private-key>'],
};

for (const [name, [input, expected]] of Object.entries(shapes)) {
  test(`F2 shape: ${name}`, () => {
    const out = redact(input, O);
    assert.equal(out, expected);
    assert.ok(!longRun(out, V), out);
  });
}

test('F2 lookalikes stay readable', () => {
  assert.equal(redact('max_tokens: 5 and psql -p 5432', O), 'max_tokens: 5 and psql -p 5432');
  assert.equal(redact('Basic information about it', O), 'Basic information about it');
});

const A200 = 200 * 1024;
const unit = (s) => s.repeat(Math.ceil(A200 / s.length)).slice(0, A200);
const adversarial = [
  'a', '@', '.', '-', ':', '/', 'a@', 'a.', 'a-', 'a:', 'a/', 'a://', 'a:a@', '@a.', 'a@a.', '-----BEGIN ',
  'eyJ-', 'eyJ.', 'sk-', 'Bearer ', 'password=', 'TOKEN_', '--token ', 'mysql ', 'Authorization: Basic ', '/Users/', '-Users-',
  '/var/folders/ab/', 'a=', '"', 'Authorization: ', 'X-', 'machine ', 'curl ', 'a:1:', 'a:1:b:', 'a:1:b:c:', 'PuTTY-User-Key-File-2:', 'pass ', 'session',
].map((s) => [s, unit(s)]);

test('F4 every regex on its own is linear on 200 KB adversarial input', () => {
  const slow = [];
  for (const [name, re] of PATTERNS) {
    for (const [label, input] of adversarial) {
      const t0 = process.hrtime.bigint();
      input.replace(re, '#');
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms > 300) slow.push(`${name} on ${JSON.stringify(label)}: ${ms.toFixed(0)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});

test('F4 redact() on 200 KB adversarial text finishes under 300 ms', () => {
  for (const [label, input] of adversarial) {
    const t0 = process.hrtime.bigint();
    redact(input, O);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 300, `${JSON.stringify(label)} took ${ms.toFixed(0)} ms`);
  }
});

test('F4 input over 64 KB is cut before masking and marked with an ellipsis', () => {
  const big = 'ok '.repeat(40000);
  const out = redact(big, O);
  assert.ok(out.length <= MAX_INPUT + 1, out.length);
  assert.ok(out.endsWith('…'));
  assert.equal(redact('short', O), 'short');
});

test('F4 a token split by the 64 KB cap leaves no readable prefix', () => {
  const token = 'gh' + 'p_' + 'A'.repeat(30);
  const text = 'a '.repeat((MAX_INPUT - 10) / 2) + token + ' tail';
  const out = redact(text, O);
  assert.ok(!out.includes('ghp_'), out.slice(-40));
  assert.ok(out.endsWith('…'));
});

test('F4 bounded e-mail and URL-credential masks still work', () => {
  assert.equal(redact('mail alice@acme.example now', O), 'mail <email> now');
  const pg = 'postg' + 'res://';
  assert.equal(redact(`${pg}alice${':'}s3cret@db.example.com/x`, O), `${pg}<redacted${':'}credentials>@db.example.com/x`);
});

const S = 'Zq7' + 'x9Kp2' + 'Lm4Rt8Wv';
const T = S + 'Ab3dEf6h';
const B64 = Buffer.from('alice:' + S).toString('base64');
const pem = (kind, end = true) => `-----BEGIN ${kind}-----\n${S}AAAA\n${S}BBBB\n` + (end ? `-----END ${kind}-----` : '');
const secretLines = [
  [`curl -H "Authorization: Token ${S}" https://api.example/x`, S],
  [`Authorization: ${S}`, S],
  [`Proxy-Authorization: Basic ${B64}`, B64],
  [`Authorization: Digest username=alice, nonce=n1, response=${S}`, S],
  [`Cookie: theme=dark; sessionid=${S}; csrftoken=${S}x`, S],
  [`Set-Cookie: sid=${S}; Path=/; HttpOnly`, S],
  [`X-Api-Key: ${S}`, S],
  [`curl -H "X-Auth-Token: ${S}" https://api.example`, S],
  [`X-Amz-Security-Token: ${S}`, S],
  [`x-custom-key: ${S}`, S],
  [`Api-Key: ${S}`, S],
  [`{"Authorization": "Bearer ${S}"}`, S],
  [`curl -u alice:${S} https://api.example`, S],
  [`curl --user alice:${S} https://api.example`, S],
  [`curl -sS -u alice:${S} -X POST https://api.example`, S],
  [`wget --password=${S} https://api.example/f`, S],
  [`wget --http-password ${S} https://api.example/f`, S],
  [`sshpass -p ${S} ssh alice@host.example`, S],
  [`sshpass -p'${S}' ssh host.example`, S],
  [`unzip -P ${S} archive.zip`, S],
  [`git clone https://alice:${S}@git.example/acme/repo.git`, S],
  [`git clone https://${T}@git.example/acme/repo.git`, T],
  [`mysql://alice:${S}@db.example:3306/app`, S],
  [`mongodb+srv://alice:${S}@cluster.example/db`, S],
  [`redis://:${S}@cache.example:6379/0`, S],
  [`amqp://alice:${S}@mq.example/`, S],
  [`https://alice:${S}@git.example`, S],
  [`{"passphrase": "${S}"}`, S],
  [`pass: ${S}`, S],
  [`client_secret: ${S}`, S],
  [`REFRESH_TOKEN=${S}`, S],
  [`access_token=${S}`, S],
  [`{"id_token": "${S}"}`, S],
  [`session: ${S}`, S],
  [`SESSIONID=${S}`, S],
  [`csrftoken=${S}`, S],
  [`auth: ${S}`, S],
  [`credentials: ${S}`, S],
  [`secret_key = ${S}`, S],
  [`db.example:5432:app:alice:${S}`, S],
  [`machine api.example login alice password ${S}`, S],
  [`machine api.example\n  login alice\n  password ${S}\n`, S],
  [`openssl enc -aes-256-cbc -pass pass:${S} -in a`, S],
  [`docker login -u alice -p ${S} registry.example`, S],
  [`redis-cli -a ${S} ping`, S],
  [`7z a -p${S} out.7z`, S],
  [`gpg --passphrase ${S} -d f.gpg`, S],
  [`tool --pass ${S}`, S],
  [pem('OPENSSH PRIVATE KEY'), S],
  [pem('EC PRIVATE KEY'), S],
  [pem('DSA PRIVATE KEY'), S],
  [pem('ENCRYPTED PRIVATE KEY'), S],
  [pem('PGP PRIVATE KEY BLOCK'), S],
  [pem('OPENSSH PRIVATE KEY', false), S],
  [`PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPublic-Lines: 1\nAAAAC3\nPrivate-Lines: 1\n${S}AAAA\nPrivate-MAC: ${'a1b2'.repeat(16)}\nafter`, S],
];

secretLines.forEach(([line, value], i) => {
  test(`N1 secret line ${i + 1}: ${line.slice(0, 28).replace(/\n/g, ' ')}`, () => {
    const out = redact(line, O);
    assert.ok(!longRun(out, value), out);
  });
});

const benign = [
  'max_tokens: 5', 'tokens: 5', 'token_count: 12', 'session_id: abc12345', 'compass: north',
  'bypass: true', 'author: alice', 'password_policy: strict', 'passport: 12345678',
  'ssh://git.example:2222/acme/repo.git', 'psql -p 5432 -h db.example', 'curl -s https://example.com/a',
  'Content-Type: application/json', 'Accept: */*', 'X-Request-Id: abc123', 'Cache-Control: no-cache',
  'User-Agent: curl/8.4', 'localhost:8080', '12:30:45:10:20', 'machine learning is fun', 'the session was closed',
  'auth failed for the request', 'docker run -p 8080:80 nginx', 'mysql -u root -P 3306 db', 'git clone https://git.example/acme/repo.git',
];

benign.forEach((line) => {
  test(`N1 benign stays readable: ${line}`, () => {
    assert.equal(redact(line, O), line);
  });
});

test('N1 header lines keep their name, mask the whole value, plain and inside -H', () => {
  assert.equal(redact('Cookie: a=1; b=2', O), 'Cookie: <redacted:header>');
  assert.equal(redact(`curl -H "X-Api-Key: ${S}" https://api.example`, O), 'curl -H "X-Api-Key: <redacted:header>" https://api.example');
  assert.equal(redact(`Authorization: Bearer ${S}`, O), 'Authorization: Bearer <redacted:bearer>');
});

const R = 'Rm5' + 'p8Wq3' + 'Xt7Nv2Kd';
const probes = [
  `SECRET_KEY_BASE=${R}`, `GITHUB_TOKEN_READONLY=${R}`, `DB_PASSWORD_PROD=${R}`,
  `ENCRYPTION_KEY=${R}`, `JWT_SIGNING_KEY=${R}`, `RAILS_MASTER_KEY=${R}`,
  `os.environ["API_KEY"] = "${R}"`, `config['password'] = '${R}'`, `process.env['DB_PASSWORD'] = '${R}'`,
  `_auth=${R}`, `aws configure set aws_secret_access_key ${R}`, `gh secret set STRIPE_KEY --body ${R}`,
  `https://acct.blob.example/c?sv=2022-11-02&ss=b&sig=${R}`,
  `password: |\n  ${R}\nnext: 1`, `auth=("user", "${R}")`, `password：${R}`, `API_KEY = ${R}`,
];
const ownLines = [
  `export STRIPE_SECRET=${R}`, `set GH_TOKEN=${R}`, `$env:NPM_TOKEN = "${R}"`, `process.env.OPENAI_API_KEY = "${R}"`,
  `ENV['SECRET_KEY']='${R}'`, `{"apiKey": "${R}"}`, `clientSecret: ${R}`, `awsSecretAccessKey = ${R}`,
  `//registry.npmjs.org/:_authToken=${R}`, `https://x.example/cb?access_token=${R}&x=1`,
  `https://s3.example/o?X-Amz-Signature=${R}&X-Amz-Expires=60`, `https://x.example/v?page=2&api_key=${R}`,
  `https://acct.blob.example/c?sv=2022-11-02&ss=b&srt=sco&sp=rl&se=2026-01-01T00:00:00Z&spr=https&sig=${R}`,
  `npm config set _authToken ${R}`, `fly secrets set DB_URL=${R} OTHER=${R}x`, `gh secret set N -b ${R}`,
  `kubectl create secret generic x --from-literal=password=${R}`, `DATABASE_PASSWORD: ${R}`, `  secretKey: ${R}`,
  `x-api-key=${R}`, `SESSION_KEY=${R}`, `Password: "${R} two"`, `heroku config:set MASTER_KEY=${R}`,
  `docker run -e AUTH_SECRET=${R} img`, `helm install x --set db.password=${R}`,
];
[...probes, ...ownLines].forEach((line, i) => {
  test(`N3 masked by name rule ${i + 1}: ${line.slice(0, 30).replace(/\n/g, ' ')}`, () => {
    const out = redact(line, O);
    assert.ok(!longRun(out, R), out);
  });
});

const benignN3 = [
  'SORT_KEY=name', 'PRIMARY_KEY=id', 'os.environ["HOME"] = "/x"', 'CACHE_KEY=v2', 'sort_key: asc', 'max_tokens: 4096',
  'token_count: 12', 'tokens: 5', 'session_id: abc12345', 'keyboard: us', 'monkey: patch', 'passive: true', 'bypass: x',
  'author: alice', 'authority: example', 'signal: SIGINT', 'signature_algorithm: sha256', 'primary_key_column: id',
  'keywords: a b', 'key_count: 3', 'num_keys: 4', 'auth: true', 'pass: true', 'private: false', 'PATH=/usr/bin',
  'DEBUG=true', 'https://x.example/?page=2&sort=asc', 'x-request-id: abc123', 'TOKEN=$GITHUB_TOKEN', 'API_KEY=<your-key>',
  'secret_name: my-db', 'compass: northwest', 'set key to 5', 'KEY_COUNT=17', 'https://x.example/a?limit=50&offset=10', // gitleaks:allow — benign lookalikes the redactor must leave alone
];
benignN3.forEach((line) => {
  test(`N3 benign byte-identical: ${line}`, () => {
    assert.equal(redact(line, O), line);
  });
});

test('N3 name rule keeps the name and the quotes, masks only the value', () => {
  assert.equal(redact(`os.environ["API_KEY"] = "${R}"`, O), 'os.environ["API_KEY"] = "<redacted:secret>"');
  assert.equal(redact(`SECRET_KEY_BASE=${R} next=1`, O), 'SECRET_KEY_BASE=<redacted:secret> next=1');
  assert.equal(redact(`https://x.example/cb?access_token=${R}&x=1`, O), 'https://x.example/cb?access_token=<redacted:secret>&x=1');
});

test('N3 gh secret set keeps --body and masks only the value', () => {
  assert.equal(redact(`gh secret set STRIPE_KEY --body ${R}`, O), 'gh secret set STRIPE_KEY --body <redacted:secret>');
  assert.equal(redact(`gh secret set STRIPE_KEY -b ${R}`, O), 'gh secret set STRIPE_KEY -b <redacted:secret>');
});

// ---- structural round: reviewer probe sets of rounds 3 and 4, value check by 8-char run ----
const PV = 'Qx7vLr2mXk8pTtZw';
const DOTENV = '.e' + 'nv';
const probeSet = {
  curlU: `curl -u alice2:${PV} https://api.example`, curlUser: `curl --user bob:${PV} https://api.example`,
  cookie: `curl -H "Cookie: session=${PV}" https://x.example`, passphrase: `"passphrase": "${PV}"`,
  authRaw: `Authorization: ${PV}`, sshpass: `sshpass -p ${PV} ssh host`, pgpass: `db.example:5432:app:app:${PV}`,
  secretKeyBase: `SECRET_KEY_BASE=${PV}`, tokenSuffix: `GITHUB_TOKEN_READONLY=${PV}`, pwSuffix: `DB_PASSWORD_PROD=${PV}`,
  encKey: `ENCRYPTION_KEY=${PV}`, signingKey: `JWT_SIGNING_KEY=${PV}`, masterKey: `RAILS_MASTER_KEY=${PV}`,
  npmrcAuth: `_auth=${PV}`, npmrcAuthTok: `//registry.npmjs.org/:_authToken=${PV}`,
  pyEnvSet: `os.environ["API_KEY"] = "${PV}"`, pyDict: `config['password'] = '${PV}'`, jsBracket: `process.env['DB_PASSWORD'] = '${PV}'`,
  awsCfg: `aws configure set aws_secret_access_key ${PV}`, ghSecret: `gh secret set STRIPE_KEY --body ${PV}`,
  azureSas: `https://acct.blob.core.windows.net/c/f?sv=2022-11-02&se=2026-12-01&sp=r&sig=${PV}%2F${PV}%3D`,
  s3presign: `https://b.s3.amazonaws.com/k?X-Amz-Credential=AK${'IA'}IOSFODNN7EXAMPLE%2F20261125&X-Amz-Signature=${PV}${PV}`,
  yamlBlock: `password: |\n  ${PV}`, tomlSpaced: `password  =  "${PV}"`,
  kubectlTok: `kubectl --token=${PV} get pods`, helmSet: `helm install x --set db.password=${PV}`,
  dockerEnv: `docker run -e POSTGRES_PASSWORD=${PV} postgres`, mysqlPw: `mysql --password=${PV}`,
  netrc: `machine api.example login bob password ${PV}`, setCookie: `Set-Cookie: sid=${PV}; HttpOnly`,
  xToken: `X-Auth-Token: ${PV}`, gitlabPriv: `PRIVATE-TOKEN: ${PV}`, privKeyB64: `"private_key": "${PV}"`,
  urlTokUser: `https://${PV}${PV}@github.com/o/r.git`, urlEmptyUser: `https://:${PV}@host/x`,
  queryApiKey: `https://api.example/v1?api_key=${PV}&x=1`, queryAccessTok: `https://api.example/cb#access_token=${PV}&t=b`,
  heredocEnv: `cat > ${DOTENV} <<EOF\nSTRIPE_SECRET=${PV}\nEOF`, psqlConn: `psql "host=db user=app password=${PV} dbname=x"`,
  dotnetConn: `Server=db;User Id=app;Password=${PV};`, jdbc: `jdbc:mysql://db/x?user=app&password=${PV}`,
  sshKeyInline: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn${PV}`,
  basicTuple: `requests.get(u, auth=("bob", "${PV}"))`, pyKw: `connect(host="db", passwd="${PV}")`,
  tabValue: `password\t=\t${PV}`, fullwidthColon: `password：${PV}`, nbspEq: `password = ${PV}`,
  phpArrow: `$cfg = ['password' => '${PV}'];`, rubyArrow: `{ :api_key => "${PV}" }`, goWalrus: `apiKey := "${PV}"`,
  pyAnnot: `api_key: str = "${PV}"`, tsAnnot: `const apiKey: string = "${PV}";`,
  escapedJson: `{\\"access_token\\":\\"${PV}\\"}`, jsonEscQuoteInVal: `{"password": "ab\\"cd${PV}"}`,
  dollarLiteral: `PASSWORD='$${PV}'`,
  slackWebhook: `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0AAAAAAA/B0BBBBBBB/${PV}`,
  discordWebhook: `curl -X POST https://discord.com/api/webhooks/123456789012345678/${PV}${PV}`,
  telegramUrl: `curl https://api.telegram.org/bot123456789:AAH${PV}${PV}/sendMessage`,
  keychainW: `security add-generic-password -a me -s svc -w ${PV}`, mongoshP: `mongosh -u admin -p ${PV} mongodb://db`,
  ldapW: `ldapsearch -x -D cn=admin -w ${PV}`, smbclient: `smbclient //srv/share -U admin%${PV}`,
  htpasswd: `htpasswd -b .htpasswd admin ${PV}`,
  mnemonic: `MNEMONIC="abandon ability able about above absent absorb abstract absurd abuse access ${PV}"`,
  nameType: `PASSWORD_TYPE_HINT=${PV}`, yamlNested: `password:\n  ${PV}`, setxWin: `setx API_TOKEN ${PV}`,
  psEnv: `$env:API_TOKEN = "${PV}"`, psEnvBare: `$Env:OPENAI_API_KEY="${PV}"`,
  dockerArg: `docker build --build-arg NPM_TOKEN=${PV} .`, envFileLineSpaces: `API_TOKEN = ${PV}`,
  jsonSpaceBeforeColon: `"client_secret" : "${PV}"`, tomlKeyDotted: `stripe.secret = "${PV}"`,
  xmlTag: `<password>${PV}</password>`, xmlAttr: `<add key="ApiKey" value="${PV}" />`,
  openssl: `openssl enc -aes-256-cbc -k ${PV} -in a`,
};

Object.entries(probeSet).forEach(([name, line]) => {
  test(`probe ${name}: no 8-char run of the value survives`, () => {
    const out = redact(line, { homedir: '/Users/alice', username: 'alice' });
    assert.ok(!longRun(out, PV), out);
  });
});

test('probe: the value is gone, not just a marker added (separator remnants)', () => {
  const o = { homedir: '/Users/alice', username: 'alice' };
  assert.equal(redact(`$cfg = ['password' => '${PV}'];`, o), "$cfg = ['password' => '<redacted:secret>'];");
  assert.equal(redact(`{ :api_key => "${PV}" }`, o), '{ :api_key => "<redacted:secret>" }');
  assert.equal(redact(`apiKey := "${PV}"`, o), 'apiKey := "<redacted:secret>"');
  assert.equal(redact(`api_key: str = "${PV}"`, o), 'api_key: str = "<redacted:secret>"');
  assert.equal(redact(`const apiKey: string = "${PV}";`, o), 'const apiKey: string = "<redacted:secret>";');
  assert.equal(redact(`{\\"access_token\\":\\"${PV}\\"}`, o), '{\\"access_token\\":\\"<redacted:secret>\\"}');
  assert.equal(redact(`{"password": "ab\\"cd${PV}"}`, o), '{"password": "<redacted:secret>"}');
  assert.equal(redact(`PASSWORD='$${PV}'`, o), "PASSWORD='<redacted:secret>'");
  assert.equal(redact(`<password>${PV}</password>`, o), '<password><redacted:secret></password>');
  assert.equal(redact(`<add key="ApiKey" value="${PV}" />`, o).includes('value="<redacted:secret>"'), true);
});

test('probe: references stay readable unless single-quoted; separators and comparisons', () => {
  const o = { homedir: '/Users/alice', username: 'alice' };
  assert.equal(redact('PASSWORD=$DB_PASS', o), 'PASSWORD=$DB_PASS');
  assert.equal(redact('PASSWORD="$DB_PASS"', o), 'PASSWORD="$DB_PASS"');
  assert.equal(redact("PASSWORD='$DB_PASS'", o), "PASSWORD='<redacted:secret>'");
  assert.equal(redact('if token == "abc"', o), 'if token == "abc"');
  assert.equal(redact('TOKEN+=suffixvalue1', o), 'TOKEN+=<redacted:secret>');
});

test('N6 mnemonic of 12 words is masked after = or :, prose is not', () => {
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.ok(!redact(`MNEMONIC="${words}"`, O).includes('abandon'));
  assert.ok(!redact(`seed phrase: ${words}`, O).includes('abandon'));
  assert.ok(!redact(`wallet = '${words}'`, O).includes('abandon'));
  const prose = '"and then you can have the other thing that will work with this tool from here"';
  assert.equal(redact(prose, O), prose);
});

// ---- entropy backstop ----
function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABETS = {
  base62: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  lowerdigit: 'abcdefghijklmnopqrstuvwxyz0123456789',
};
const randomSecret = (rand, alphabet, length) => Array.from({ length }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');

const secretSpecs = [];
{
  const rand = prng(20261125);
  for (const [alphabet, lengths] of [['base62', [24, 32, 40, 48, 64, 22, 28, 36]], ['base64url', [26, 32, 43, 56, 30, 38, 44]], ['base64', [32, 44, 64, 28, 36, 40, 52]], ['lowerdigit', [32, 40, 48, 36, 30, 44, 26, 34]]]) {
    for (const length of lengths) secretSpecs.push(randomSecret(rand, ALPHABETS[alphabet], length));
  }
}

test('entropy: 30 random secrets with no known prefix or name are masked', () => {
  assert.ok(secretSpecs.length >= 30, String(secretSpecs.length));
  const missed = [];
  for (const secret of secretSpecs) {
    const out = redact(`the value was ${secret} in the log`, O);
    if (longRun(out, secret) || !out.includes('<redacted:entropy>')) missed.push(`${secret.length}:${secret.slice(0, 6)}`);
  }
  assert.deepEqual(missed, []);
});

test('entropy: 30 benign lookalikes stay byte-identical', () => {
  const rand = prng(7);
  const sha = (n) => randomSecret(rand, '0123456789abcdef', n);
  const uuid = () => `${sha(8)}-${sha(4)}-${sha(4)}-${sha(4)}-${sha(12)}`;
  const integrity = (alg, bytes) => `${alg}-${Buffer.from(Array.from({ length: bytes }, () => Math.floor(rand() * 256))).toString('base64')}`;
  const benign = [
    `commit ${sha(40)}`, `fixup ${sha(7)}`, `sha ${sha(40)}`, `id ${uuid()}`, `id ${uuid()}`, `session ${uuid()}`,
    `integrity ${integrity('sha512', 64)}`, `integrity ${integrity('sha256', 32)}`, `integrity ${integrity('sha1', 20)}`,
    'resolved https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
    'useAuthenticatedSessionProvider', 'AbstractSingletonProxyFactoryBean', 'createAsyncThunkWithTypesConfig',
    'const handleUserAuthenticationFailure = () => {}', 'InternalServerErrorExceptionHandler',
    'mcp__docs__query', 'mcp__lsp__find_symbols', 'mcp__search__web_search',
    `data ${Buffer.from('hello world this is plain text content for the test').toString('base64')}`,
    `data ${Buffer.from('The quick brown fox jumps over the lazy dog again and again').toString('base64')}`,
    'src/components/layout/HeaderNavigation', 'scripts/lib/detectors/block-bypassed', 'tests/fixtures/transcripts/long-session',
    'Acme-Marketing-Site-web-frontend', 'acme-audit-toolkit-redact-names', 'nightly-report-fix-order-session-start-hook',
    'internationalization-and-localization-config', 'feature_flag_new_checkout_flow_rollout', 'accessibility-compliance-review-checklist',
    'Fetching dependency graph for the workspace packages', 'see the guide on how to configure the audit hook properly',
  ];
  assert.ok(benign.length >= 30, String(benign.length));
  for (const line of benign) assert.equal(redact(line, O), line);
});

test('entropy: ReDoS and size caps hold for the new passes', () => {
  const shapes = ['aB3', 'abc def ', '/a', 'a/', '=', '_', 'abc ', 'a_b-C', 'x/y/Z9', 'abcdefghij ', '"abc def ghi ', 'q: abc '];
  for (const shape of shapes) {
    const input = shape.repeat(Math.ceil(204800 / shape.length)).slice(0, 204800);
    for (const [name, re] of PATTERNS.filter(([n]) => n === 'entropy-candidate' || n === 'mnemonic')) {
      const t0 = process.hrtime.bigint();
      input.replace(re, '#');
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 300, `${name} on ${JSON.stringify(shape)} took ${ms.toFixed(0)} ms`);
    }
    const t1 = process.hrtime.bigint();
    redact(input, O);
    assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 300, `redact on ${JSON.stringify(shape)}`);
  }
});

// ---- N8: hex runs and base64 credentials ----
const hexRand = prng(424242);
const hexOf = (n) => randomSecret(hexRand, '0123456789abcdef', n);

test('N8 unnamed hex secrets of 32, 40, 64 and 128 chars are masked', () => {
  const cases = [
    `openssl rand -hex 32\n${hexOf(64)}`, `generated ${hexOf(32)} done`, `key material ${hexOf(32)}`,
    `got ${hexOf(40)} back`, `value=${hexOf(128)}x`, `https://hooks.example/in/${hexOf(64)}`,
    `result: ${hexOf(64).toUpperCase()}`, `${hexOf(32)}`, `a ${hexOf(64)} b`,
  ];
  for (const line of cases) {
    const out = redact(line, O);
    const hex = line.match(/[0-9a-fA-F]{32,}/)[0];
    assert.ok(!longRun(out, hex), out);
    assert.ok(out.includes('<redacted:entropy>'), out);
  }
});

test('N8 base64 of user:password is masked, base64 of prose is kept', () => {
  const credential = Buffer.from('alice:s3cretpw').toString('base64');
  assert.equal(credential.length, 20);
  const out = redact(`blob ${credential} end`, O);
  assert.ok(!longRun(out, credential), out);
  assert.ok(!longRun(redact(`blob ${Buffer.from('bob:Another-Passw0rd!').toString('base64')} end`, O), 'Ym9iOkFu'));
  const prose = `data ${Buffer.from('The quick brown fox jumps over the lazy dog again and again').toString('base64')}`;
  assert.equal(redact(prose, O), prose);
  const withColon = Buffer.from('note: this is a plain sentence about the weather today').toString('base64');
  assert.ok(!redact(`x ${withColon} y`, O).includes('this is'), 'decoded text with a colon is no longer exempt');
});

test('N8 git object ids, digests and UUIDs stay byte-identical', () => {
  const sha = hexOf(40);
  const digest = hexOf(64);
  const lines = [
    `commit ${sha}\nAuthor: Alice\nDate: Tue Nov 25 12:00:00 2026\n\n    fix: thing`,
    `parent ${hexOf(40)}`, `tree ${hexOf(40)}`, `HEAD ${hexOf(40)}`, `fixup @${hexOf(40)}`, `rev ${hexOf(40)}`,
    `merge ${hexOf(40)}`, `sha1: ${hexOf(40)}`, `https://git.example.test/acme/web/commit/${hexOf(40)}`,
    `https://git.example.test/acme/web/blob/${hexOf(40)}/src/index.js`,
    `short ${hexOf(7)} and ${hexOf(12)}`, `sha256:${digest}`, `acme/web@sha256:${hexOf(64)}`, `Digest: sha256:${hexOf(64)}`,
    `md5 ${hexOf(32)}`, `checksum ${hexOf(32)}`, `sha256 ${hexOf(64)}`, `sha512:${hexOf(128)}`,
    `id 123e4567-e89b-42d3-a456-426614174000`, `session ${'a1b2c3d4-0000-4000-8000-0123456789ab'}`,
  ];
  for (const line of lines) assert.equal(redact(line, O), line);
});

test('N8 hex rules keep the ReDoS and size guarantees', () => {
  for (const shape of ['abcdef0123456789', 'a1', 'deadbeef/', '/a1b2c3d4e5f60718', 'commit ']) {
    const input = shape.repeat(Math.ceil(204800 / shape.length)).slice(0, 204800);
    const t0 = process.hrtime.bigint();
    redact(input, O);
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 300, `hex shape ${shape}`);
  }
});
