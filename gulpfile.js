const gulp = require("gulp");
const { SimpleKeyStoreSigner, InMemoryKeyStore, KeyPair, LocalNodeConnection, NearClient, Near } = require('nearlib');
const neardev = require('nearlib/dev');
const UnencryptedFileSystemKeyStore = require('./unencrypted_file_system_keystore');
const fs = require('fs');
const yargs = require('yargs');
const ncp = require('ncp').ncp;
const rimraf = require('rimraf');
 
ncp.limit = 16;
 
gulp.task("build:model", async function (done) {
  const asc = require("assemblyscript/bin/asc");
  const buildModelFn = function(fileName) {
    asc.main([
      fileName,
      "--baseDir", yargs.argv.out_dir,
      "--nearFile", generateNearFileFullPath(fileName),
      "--measure"
    ], done);
  };
  yargs.argv.model_files.forEach(buildModelFn);
});

gulp.task("build:bindings", async function (done) {
  const asc = require("assemblyscript/bin/asc");
  asc.main([
    yargs.argv.contract_file,
    "--baseDir", yargs.argv.out_dir,
    "--binaryFile", yargs.argv.out_file,
    "--nearFile", generateNearFileFullPath(yargs.argv.contract_file),
    "--measure"
  ], done);
});

gulp.task("build:all", gulp.series('build:model', 'build:bindings', function (done) {
  const asc = require("assemblyscript/bin/asc");
  asc.main([
    "../out/main.near.ts",
    "--baseDir", yargs.argv.out_dir,
    "-O3",
    "--binaryFile", yargs.argv.out_file,
    "--sourceMap",
    "--measure"
  ], done);
}));

async function ensureDir (dirPath) {
  try {
    await new Promise((resolve, reject) => {
      fs.mkdir(dirPath, { recursive: true }, err => err ? reject(err) : resolve())
    })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

gulp.task('copyfiles', async function(done) {
  // Need to wait for the copy to finish, otherwise next tasks do not find files.
  console.log("Copying files to build directory v2");
  const copyDirFn = () => { 
      return new Promise(resolve => {
          ncp (yargs.argv.src_dir, yargs.argv.out_dir, response => resolve(response));
  })};
  await copyDirFn();

  // find the dependencies
  const copyFileFn = (from, to) => { 
    return new Promise(resolve => {
        ncp (from, to, response => resolve(response));
  })};
  await copyFileFn("./node_modules/near-runtime-ts/near.ts", yargs.argv.out_dir + "/near.ts");
  await ensureDir(yargs.argv.out_dir + "/json");
  await copyFileFn("./node_modules/assemblyscript-json/assembly/encoder.ts", yargs.argv.out_dir + "/json/encoder.ts");
  await copyFileFn("./node_modules/assemblyscript-json/assembly/decoder.ts", yargs.argv.out_dir + "/json/decoder.ts");
  done();
});

gulp.task('clean', async function(done) {
  const rmDirFn = () => {
      return new Promise(resolve => {
      rimraf(yargs.argv.out_dir, response => resolve(response));
  })};
  await rmDirFn();
  console.log("clean done");
  done();
});

gulp.task('build', gulp.series('clean', 'copyfiles', 'build:all'));

// Only works for dev environments
gulp.task('createDevAccount', async function(argv) {
    const keyPair = await KeyPair.fromRandomSeed();
    const accountId = argv.account_id;
    const nodeUrl = argv.node_url;

    const options = {
        nodeUrl,
        accountId,
        useDevAccount: true,
        deps: {
            keyStore: new InMemoryKeyStore(),
            storage: {},
        }
    };

    const near = await neardev.connect(options);
    await neardev.createAccountWithLocalNodeConnection(accountId, keyPair.getPublicKey());
    const keyStore = new UnencryptedFileSystemKeyStore();
    keyStore.setKey(accountId, keyPair);
});

async function deployContractAndWaitForTransaction(accountId, contractName, data, near) {
    const deployContractResult = await near.deployContract(contractName, data);
    const waitResult = await near.waitForTransactionResult(deployContractResult);
    return waitResult;
}


function generateNearFileFullPath(fileName) {
  return "../" + yargs.argv.out_dir + "/" + generateNearFileName(fileName);
}

// converts file.ts to file.near.ts
function generateNearFileName(fileName) {
  return fileName.replace(/.ts$/, '.near.ts');
}

gulp.task('deploy', async function(argv) {
    const keyStore = new UnencryptedFileSystemKeyStore();
    let accountId = argv.account_id;
    if (!accountId) {
        // see if we only have one account in keystore and just use that.
        const accountIds = await keyStore.getAccountIds();
        if (accountIds.length == 1) {
            accountId = accountIds[0];
        }
    }
    if (!accountId) {
        throw 'Please provide account id and make sure you created an account using near create_account'; 
    }
    const nodeUrl = argv.node_url;
    const options = {
        nodeUrl,
        accountId,
        deps: {
          keyStore,
          storage: {},
        }
    };

    const near = await neardev.connect(options);
    const contractData = [...fs.readFileSync(argv.wasm_file)];

    // Contract name
    const contractName = argv.contract_name;
    console.log(
        "Starting deployment. Account id " + accountId + ", contract " + contractName + ", url " + nodeUrl, ", file " + argv.wasm_file);
    const res = await deployContractAndWaitForTransaction(
        accountId, contractName, contractData, near);
    if (res.status == "Completed") {
        console.log("Deployment succeeded.");
    } else {
        console.log("Deployment transaction did not succeed: ", res);
    }
});
