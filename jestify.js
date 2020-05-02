/**
 * Jest Conversion script, adapted from https://gist.github.com/apiv/02b0b5b70bd752304bc8c7e940a5ea29
 *
 * USAGE: `node jest-convert.js /path/to/rootDirectory`
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

require('colors');
const fg = require('fast-glob');
const nodeReplace = require('replace');
const simpleGit = require('simple-git/promise');

const fsExists = promisify(fs.exists);

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(`[jest-convert]`.magenta, ...args);
}

async function gitRoot(directory) {
  let gitRootDirectory = directory;
  while (!(await fsExists(path.join(gitRootDirectory, '.git')))) {
    gitRootDirectory = path.dirname(gitRootDirectory);
    if (gitRootDirectory === '/') {
      throw new Error('could not find git rootdir');
    }
  }
  return gitRootDirectory;
}

async function dirtyFiles(git, where) {
  const gitRootDirectory = await gitRoot(where);
  const relativePath = where.slice(gitRootDirectory.length + 1);
  const status = await git.status();
  return status.files.filter((infos) => infos.path.startsWith(relativePath));
}

async function ensureNoUnstagedChanges(git, where) {
  const files = await dirtyFiles(git, where);
  if (files.length) {
    log('Cannot run when there are unstaged git changes');
    process.exit(1);
  }
}

async function commitDirty(git, where, message) {
  if ((await dirtyFiles(git, where)).length) {
    await git.add(where);
    await git.commit(message, [], { '--no-verify': undefined });
  }
}

function checkRootDirectory(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) {
    log('Directory', rootDirectory.green, 'does not exist');
    process.exit(1);
  }
}

async function* collectTestFiles(rootDirectory) {
  const patterns = /.specs?.js$/.test(rootDirectory)
    ? [rootDirectory]
    : ['**/*spec.js', '**/*specs.js'].map((p) => path.join(rootDirectory, p));
  for await (const filepath of fg.stream(patterns)) {
    log(`Found ${filepath}`);
    yield filepath;
  }
}

async function initializeJestFiles(git, rootDirectory) {
  log(`Initializing jest files in ${rootDirectory}`);
  for await (const karmaFilePath of collectTestFiles(rootDirectory)) {
    const jestFilePath = karmaFilePath.replace(/specs?\.js$/, 'test.js');
    await promisify(fs.copyFile)(karmaFilePath, jestFilePath);
    await git.add(jestFilePath);
  }
  await git.commit(`jestify :: added jest files in ${rootDirectory}`);
}

async function prettier(git, rootDirectory) {
  const newFiles = /.specs?.js/.test(rootDirectory)
    ? rootDirectory.replace(/.specs?.js$/, '.test.js')
    : `${rootDirectory}/**/*test.js`;
  await exec(`./node_modules/.bin/prettier --write ${newFiles}`);
  await commitDirty(git, rootDirectory, `jestify :: prettier on ${rootDirectory}`);
}

async function transformJestFile(git, rootDirectory) {
  log(`[jest-codemod]`.blue, 'mocha');
  await exec(
    `./node_modules/.bin/jscodeshift -t ./node_modules/jest-codemods/dist/transformers/mocha.js ${rootDirectory}`,
  );

  await commitDirty(git, rootDirectory, `jestify :: jest-codemods / mocha on ${rootDirectory}`);

  log(`[jest-codemod]`.blue, 'chai-assert');
  await exec(
    `./node_modules/.bin/jscodeshift -t ./node_modules/jest-codemods/dist/transformers/chai-assert.js ${rootDirectory}`,
  );

  await commitDirty(
    git,
    rootDirectory,
    `jestify :: jest-codemods / chai-asssert on ${rootDirectory}`,
  );
  log(`[jest-codemod]`.blue, 'chai-should');
  await exec(
    `./node_modules/.bin/jscodeshift -t ./node_modules/jest-codemods/dist/transformers/chai-should.js ${rootDirectory}`,
  );

  await commitDirty(
    git,
    rootDirectory,
    `jestify :: jest-codemods / chai-should on ${rootDirectory}`,
  );
  log(`[jest-codemod]`.blue, 'expect');
  await exec(
    `./node_modules/.bin/jscodeshift -t ./node_modules/jest-codemods/dist/transformers/expect.js ${rootDirectory}`,
  );

  await commitDirty(git, rootDirectory, `jestify :: jest-codemods / expect on ${rootDirectory}`);
}

async function runTransformations(git, rootDirectory) {
  async function replace(from, to) {
    const command = `find ${rootDirectory} -name "*.test.js" -exec sed -i '' 's/${from}/${to}/g' {} \\;`;
    log(`[replace]`.yellow, from, '->'.bold, to);
    await exec(command);
  }

  function advancedReplace(options) {
    nodeReplace({
      recursive: true,
      paths: [rootDirectory],
      include: '*.test.js',
      ...options,
    });
  }

  // quick fix for a jest-codemod conversion that wasn't quite right
  advancedReplace({
    regex: /expect\(typeof (.*?)\)\.toBe\((.*?)\)/g,
    replacement: 'expect($1).toStrictEqual(expect.any($2))',
  });

  advancedReplace({
    regex: /(sinon|sandbox).stub\((.*?)\).returns\(/g,
    replacement: 'jest.spyOn($1).mockReturnValue(',
  });

  // .to.be.a and .to.be.an
  advancedReplace({
    regex: /\.to((\.not)?)\.be\.(a|an)\((.*?)\)/g,
    replacement: '$1.toStrictEqual(expect.any($2))',
  });

  // .to.have.length
  advancedReplace({
    regex: /\.to((\.not)?)\.have\.length\((.*?)\)/g,
    replacement: '$1.toHaveLength($2)',
  });

  // .to.match
  advancedReplace({
    regex: /\.to((\.not)?)\.match\((.*?)\)/g,
    replacement: '$1.toMatch($2)',
  });

  // .to.be.an.instanceof
  advancedReplace({
    regex: /\.to((\.not)?)\.be\.an\.instanceof\((.*?)\)/g,
    replacement: '$1.toBeInstanceOf($2)',
  });

  advancedReplace({
    regex: /expect\((.*?)\)\.to\.have\.text\((.*?)\)/g,
    replacement: 'expect($1.text()).toContain($2)',
  });

  await replace('sinon.spy', 'jest.fn');
  await replace('sandbox.spy', 'jest.fn');

  // remove sandbox imports
  await replace('sandbox, ', '');
  await replace(', sandbox', '');
  await replace(', sandbox, ', ',');

  // mock has been called
  await replace('.called).to.be.false', ').not.toHaveBeenCalled()');
  await replace('.called).to.eq(true)', ').toHaveBeenCalled()');
  await replace('.called).to.eq(false)', ').not.toHaveBeenCalled()');

  await replace('.to.eq(', '.toStrictEqual(');
  await replace('.to.not.eq(', '.not.toStrictEqual(');
  await replace('.to.eql(', '.toMatchObject(');
  await replace('.to.not.eql(', '.not.toMatchObject(');

  // .to.not.have.length - when not called as a fn
  await replace('.to.not.have.length', '.toHaveLength(0)');

  // .to.contain
  await replace('.to.contain(', '.toContain(');
  await replace('.to.not.contain(', '.not.toContain(');

  // .to.contain.string
  await replace('.to.contain.string(', '.toContain(');

  // .to.equal
  await replace('.to.equal(', '.toMatchObject(');
  await replace('.to.not.equal(', '.not.toMatchObject(');

  // .to.be.defined
  await replace('.to.be.defined', '.toBeDefined()');
  await replace('.to.not.be.defined', '.not.toBeDefined()');

  // .to.be.null
  await replace('.to.be.null', '.toBe(null)');
  await replace('.to.not.be.null', '.not.toBe(null)');

  // .to.be.true
  await replace('.to.be.true', '.toBe(true)');
  await replace('.to.not.be.true', '.not.toBe(true)');

  // .to.be.false
  await replace('.to.be.false', '.toBe(false)');
  await replace('.to.not.be.false', '.not.toBe(false)');

  // .to.have.been.called*
  await replace('.to.have.been.calledOnce', '.toHaveBeenCalledTimes(1)');
  await replace('.to.have.been.called.exactly(', '.toHaveBeenCalledTimes(');

  await replace('.to.have.beenCalled', '.toHaveBeenCalled()');
  await replace('.to.have.beenCalledOnce(', '.toHaveBeenCalledTimes(1)');

  await replace('.to.have.been.calledWith(', '.toHaveBeenCalledWith(');
  await replace('.to.have.been.calledWithMatch(', '.toHaveBeenCalledWith(');
  await replace('.to.have.been.calledWithExactly(', '.toHaveBeenCalledWith(');

  await replace('.to.have.been.called.once', '.toHaveBeenCalledTimes(1)');
  await replace('.to.have.been.calledTwice', '.toHaveBeenCalledTimes(2)');
  await replace('.to.have.been.called.twice', '.toHaveBeenCalledTimes(2)');

  // .to.not.have.been.called*
  await replace('.to.not.have.been.calledOnce', '.not.toHaveBeenCalledTimes(1)');
  await replace('.to.not.have.been.called.exactly(', '.not.toHaveBeenCalledTimes(');

  await replace('.to.not.have.beenCalled', '.not.toHaveBeenCalled()');
  await replace('.to.not.have.beenCalledOnce(', '.not.toHaveBeenCalledTimes(1)');

  await replace('.to.not.have.been.calledWith(', '.not.toHaveBeenCalledWith(');
  await replace('.to.not.have.been.calledWithMatch(', '.not.toHaveBeenCalledWith(');
  await replace('.to.not.have.been.calledWithExactly(', '.not.toHaveBeenCalledWith(');

  // remaining .been.called\\n
  await replace('.to.have.been.called', '.toHaveBeenCalled()');
  await replace('.to.not.have.been.called', '.not.toHaveBeenCalled()');

  // stub
  await replace('sinon.stub', 'jest.spyOn');
  await replace('sandbox.stub', 'jest.spyOn');

  // mockFn.lastCall
  await replace('.lastCall', '.mock.calls.slice().pop()');
  await replace('.args\\[', '.mock.calls\\[');
  await replace('.slice().pop().mock.calls', '');

  // mock function reset and restore
  await replace('.reset()', '.mockClear()');
  await replace('.restore()', '.mockRestore()');
  await replace('timekeeper.mockClear()', 'timekeeper.reset()');

  // expect.any fixes
  await replace(`expect.any('function')`, `expect.any(Function)`);
  await replace(`expect.any('boolean')`, `expect.any(Boolean)`);
  await replace(`expect.any('array')`, `expect.any(Array)`);
  await replace(`expect.any('object')`, `expect.any(Object)`);
  await replace(`expect.any('string')`, `expect.any(String)`);

  await commitDirty(git, rootDirectory, `jestify :: replace assertions in ${rootDirectory}`);
}

async function run(rootDirectory) {
  checkRootDirectory(rootDirectory);
  const gitRootDirectory = await gitRoot(rootDirectory);
  const git = simpleGit(gitRootDirectory);
  log(`Processing directory ${rootDirectory}`);
  await ensureNoUnstagedChanges(git, rootDirectory);
  await initializeJestFiles(git, rootDirectory);
  await transformJestFile(git, rootDirectory);
  await runTransformations(git, rootDirectory);
  await prettier(git, rootDirectory);
}

if (process.argv.length !== 3) {
  log('USAGE: node jest-convert.js <root-dir>');
  process.exit(1);
}
run(process.argv[2]);
