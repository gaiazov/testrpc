var Account = require('ethereumjs-account');
var Block = require('ethereumjs-block');
var VM = require('ethereumjs-vm');
var Trie = require('merkle-patricia-tree');
var FakeTransaction = require('ethereumjs-tx/fake.js');
var utils = require('ethereumjs-util');
var seedrandom = require('seedrandom');
var bip39 = require('bip39');
var hdkey = require('ethereumjs-wallet/hdkey');
var async = require("async");
var BlockchainDouble = require("./blockchain_double.js");
var FallbackBlockchain = require("./utils/fallbackblockchain.js");
var Web3 = require('web3');

var Log = require("./utils/log");
var to = require('./utils/to');
var random = require('./utils/random');
var txhelper = require('./utils/txhelper');

StateManager = function(options) {
  var self = this;

  if (options == null) {
    options = {};
  }

  if (options.fallback) {
    this.blockchain = new FallbackBlockchain(options);
  } else {
    this.blockchain = new BlockchainDouble(options);
  }

  this.vm = this.blockchain.vm;
  this.stateTrie = this.blockchain.stateTrie;

  this.accounts = {};
  this.blockLogs = {};
  this.coinbase = null;

  this.fallbackEnabled = options.fallback && options.fallback.length > 0;
  this.fallbackAddress = options.fallback;

  this.transactions = {};
  this.latest_filter_id = 1;
  this.transaction_queue = [];
  this.transaction_processing == false;
  this.snapshots = [];
  this.logger = options.logger || console;
  this.net_version = new Date().getTime();
  this.rng = seedrandom(options.seed);
  this.mnemonic = options.mnemonic || bip39.entropyToMnemonic(random.randomBytes(16, this.rng));
  this.wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeed(this.mnemonic));
  this.wallet_hdpath = "m/44'/60'/0'/0";

  this.gasPriceVal = '1';

  if (options.gasPrice) {
    this.gasPriceVal = utils.stripHexPrefix(utils.intToHex(options.gasPrice));
  }
}

StateManager.prototype.initialize = function(options, callback) {
  var self = this;

  this.blockchain.initialize(function() {
    // Start blocktime processing once we're finished adding accounts.
    function finished() {
      if (options.blocktime) {
        self.blocktime = options.blocktime;
        setTimeout(self.mineOnInterval, self.blocktime * 1000);
      }
      callback();
    };

    if (options.accounts) {
      async.each(options.accounts, function(account, next) {
        self.addAccount(account, next);
      }, finished);
    } else {
      // Add 10 accounts, for testing purposes.
      async.timesSeries(this.total_accounts || 10, function(n, next) {
        self.addAccount({}, next);
      }, finished);
    }
  });
};

StateManager.prototype.mineOnInterval = function() {
  // Queue up to mine the block once the transaction is finished.
  if (this.transaction_processing == true) {
    setTimeout(this.mineOnInterval, 100);
  } else {
    this.blockchain.processNextBlock();
    setTimeout(this.mineOnInterval, this.blocktime * 1000);
  }
};

StateManager.prototype.addAccount = function(opts, callback) {
  var self = this;

  var secretKey;
  var balance;

  if (opts.secretKey) {
    secretKey = utils.toBuffer(to.hex(opts.secretKey));
  } else {
    var index = Object.keys(this.accounts).length;
    var acct = this.wallet.derivePath(this.wallet_hdpath + index) // index is a number
    secretKey = acct.getWallet().getPrivateKey() // Buffer
  }

  var publicKey = utils.privateToPublic(secretKey);
  var address = utils.publicToAddress(publicKey);

  var account = new Account();

  if (opts.balance) {
    account.balance = to.hex(opts.balance)
  } else {
    account.balance = "0x0000000000000056bc75e2d63100000";
  }

  this.stateTrie.put(address, account.serialize(), function(err, result) {
    if (err != null) {
      callback(err);
      return;
    }

    var data = {
      secretKey: secretKey,
      publicKey: publicKey,
      address: to.hex(address),
      account: account
    };

    if (self.coinbase == null) {
      self.coinbase = to.hex(address);
    }

    self.accounts[to.hex(address)] = data;

    callback();
  });
}

StateManager.prototype.blockNumber = function() {
  return this.blockchain.height;
};

StateManager.prototype.gasPrice = function() {
  return this.gasPriceVal;
}

StateManager.prototype.getBalance = function(address, callback) {
  var self = this;

  address = new Buffer(utils.stripHexPrefix(address), "hex");
  this.vm.stateManager.getAccountBalance(address, function(err, result) {
    if (err != null) {
      callback(err);
    } else {
      if (typeof result == "undefined") {
        result = new Buffer(0);
      }
      callback(null, to.hex(result));
    }
  });
}

StateManager.prototype.getTransactionCount = function(address, callback) {
  var self = this;
  address = new Buffer(utils.stripHexPrefix(address), "hex");
  this.vm.stateManager.getAccount(address, function(err, result) {
    if (err != null) {
      callback(err);
    } else {
      var nonce = result.nonce;
      if (typeof nonce == "undefined") {
        nonce = new Buffer(0);
      }
      callback(null, to.hex(nonce));
    }
  });
}

StateManager.prototype.getCode = function(address, callback) {
  this.blockchain.getCode(address, function(err, code) {
    if (code) {
      code = to.hex(code);
    }
    callback(err, code);
  });
}

StateManager.prototype.getTransaction = function(hash) {
  return this.transactions[hash];
};

StateManager.prototype.queueRawTransaction = function(rawTx, callback) {
  var data = new Buffer(utils.stripHexPrefix(rawTx), 'hex');

  var tx = new FakeTransaction(data);
  var txParams = {
    from:     (tx.from     && tx.from.length    ) ? '0x'+tx.from.toString('hex')     : null,
    to:       (tx.to       && tx.to.length      ) ? '0x'+tx.to.toString('hex')       : null,
    gas:      (tx.gas      && tx.gas.length     ) ? '0x'+tx.gas.toString('hex')      : null,
    gasPrice: (tx.gasPrice && tx.gasPrice.length) ? '0x'+tx.gasPrice.toString('hex') : null,
    value:    (tx.value    && tx.value.length   ) ? '0x'+tx.value.toString('hex')    : null,
    data:     (tx.data     && tx.data.length    ) ? '0x'+tx.data.toString('hex')     : null,
  }

  this.queueTransaction("eth_sendRawTransaction", txParams, callback);
};

StateManager.prototype.queueStorage = function(address, position, block, callback) {
  this.transaction_queue.push({
    method: "eth_getStorageAt",
    address: utils.addHexPrefix(address),
    position: utils.addHexPrefix(position),
    block: block,
    callback: callback
  });

  // We know there's work, so get started.
  this.processNextAction();
}

StateManager.prototype.queueTransaction = function(method, tx_params, callback) {
  if (tx_params.from == null) {
    callback(new Error("from not found; is required"));
    return;
  }

  tx_params.from = utils.addHexPrefix(tx_params.from);

  if (method == "eth_sendTransaction" && Object.keys(this.accounts).indexOf(tx_params.from) < 0) {
    return callback(new Error("could not unlock signer account"));
  }

  var rawTx = {
      gasPrice: "0x1",
      gasLimit: this.blockchain.gasLimit,
      value: '0x0',
      data: ''
  };

  if (tx_params.gas != null) {
    rawTx.gasLimit = utils.addHexPrefix(tx_params.gas);
  }

  if (tx_params.gasPrice != null) {
    rawTx.gasPrice = utils.addHexPrefix(tx_params.gasPrice);
  }

  if (tx_params.to != null) {
    rawTx.to = utils.addHexPrefix(tx_params.to);
  }

  if (tx_params.value != null) {
    rawTx.value = utils.addHexPrefix(tx_params.value);
  }

  if (tx_params.data != null) {
    rawTx.data = utils.addHexPrefix(tx_params.data);
  }

  if (tx_params.nonce != null) {
    rawTx.nonce = utils.addHexPrefix(tx_params.nonce);
  }

  // Error checks
  if (rawTx.to && typeof rawTx.to != "string") {
    return callback(new Error("Invalid to address"));
  }

  // Get the nonce for this address, taking account any transactions already queued.
  var self = this;
  var address = utils.toBuffer(tx_params.from);
  this.blockchain.getQueuedNonce(address, function(err, nonce) {
    // If the user specified a nonce, use that instead.
    if (rawTx.nonce == null) {
      rawTx.nonce = to.hex(nonce);
    }

    // Edit: Why is this here?
    if (rawTx.to == '0x0') {
      delete rawTx.to
    }

    var tx = new FakeTransaction(rawTx);
    tx.from = address;

    self.transaction_queue.push({
      method: method,
      from: tx_params.from,
      tx: tx,
      callback: callback
    });

    // We know there's work, so get started.
    self.processNextAction();
  });
};

StateManager.prototype.processNextAction = function(override) {
  var self = this;

  if (override != true) {
    if (this.transaction_processing == true || this.transaction_queue.length == 0) {
      return;
    }
  }

  var queued = this.transaction_queue.shift();

  this.transaction_processing = true;

  var intermediary = function(err, result) {
    queued.callback(err, result);

    if (self.transaction_queue.length > 0) {
      self.processNextAction(true);
    } else {
      self.transaction_processing = false;
    }
  };

  if (queued.method == "eth_getStorageAt") {
    this.blockchain.getStorage(queued.address, queued.position, queued.block, function(err, result) {
      if (err) return intermediary(err);
      result = to.hex(result);
      intermediary(null, result);
    });
  } else if (queued.method == "eth_sendTransaction" || queued.method == "eth_sendRawTransaction") {
    this.processTransaction(queued.from, queued.tx, intermediary);
  }
};

StateManager.prototype.sign = function(address, dataToSign) {
    var secretKey = this.accounts[to.hex(address)].secretKey;
    var sgn = utils.ecsign(new Buffer(dataToSign.replace('0x',''), 'hex'), new Buffer(secretKey));
    var r = utils.fromSigned(sgn.r);
    var s = utils.fromSigned(sgn.s);
    var v = utils.bufferToInt(sgn.v) - 27;
    r = utils.toUnsigned(r).toString('hex');
    s = utils.toUnsigned(s).toString('hex');
    v = utils.stripHexPrefix(utils.intToHex(v));
    return utils.addHexPrefix(r.concat(s, v));
};

StateManager.prototype.processTransaction = function(from, tx, callback) {
  var self = this;

  this.blockchain.queueTransaction(tx);

  this.blockchain.processNextBlock(function(err, results) {
    if (err) return callback(err);

    var tx_hash = to.hex(tx.hash());

    var receipt = results.receipts[0];
    var result = results.results[0];

    if (result.vm.exception != 1) {
      callback(new Error("VM Exception while executing transaction: " + result.vm.exceptionError));
      return;
    }

    var block = self.blockchain.latestBlock();

    var logs = [];

    for (var i = 0; i < receipt.logs.length; i++) {
      var log = receipt.logs[i];
      var address = to.hex(log[0]);
      var topics = []

      for (var j = 0; j < log[1].length; j++) {
        topics.push(to.hex(log[1][j]));
      }

      var data = to.hex(log[2]);

      logs.push(new Log({
        logIndex: to.hex(i),
        transactionIndex: "0x0",
        transactionHash: tx_hash,
        block: block,
        address: address,
        data: data,
        topics: topics,
        type: "mined"
      }));
    }

    var tx_result = {
      tx: tx,
      block_number: to.hex(block.header.number),
      block: block,
      stateRoot: to.hex(receipt.stateRoot),
      gasUsed: to.hex(receipt.gasUsed),
      bitvector: to.hex(receipt.bitvector),
      logs: logs,
      createdAddress: result.createdAddress != null ? to.hex(result.createdAddress) : null,
      bloom: result.bloom,
      amountSpent: result.amountSpent
    };

    self.transactions[tx_hash] = tx_result;
    self.blockLogs[to.hex(block.header.number)] = logs;

    self.logger.log("");
    self.logger.log("  Transaction: " + tx_hash);

    if (tx_result.createdAddress != null) {
      self.logger.log("  Contract created: " + tx_result.createdAddress);
    }

    self.logger.log("  Gas usage: " + utils.bufferToInt(to.hex(tx_result.gasUsed)));
    self.logger.log("  Block Number: " + to.hex(block.header.number));
    self.logger.log("");

    callback(null, tx_hash);
  });
};

StateManager.prototype.getLogs = function(filter) {
  var fromblock, toblock;

  fromblock = this.blockchain.getBlock(filter.fromBlock || "latest");
  toblock = this.blockchain.getBlock(filter.toBlock || "latest");

  var logs = [];

  for (var i = utils.bufferToInt(fromblock.header.number); i <= utils.bufferToInt(toblock.header.number); i++) {
    var hexnumber = to.hex(i);
    logs.push.apply(logs, this.blockLogs[hexnumber]);
  }

  return logs;
};

// Note: Snapshots have 1-based ids.
StateManager.prototype.snapshot = function() {
  this.snapshots.push({
    root: this.stateTrie.root,
    blockNumber: this.blockchain.height
  });

  this.vm.stateManager.checkpoint();

  this.logger.log("Saved snapshot #" + this.snapshots.length);

  return to.hex(this.snapshots.length);
};

StateManager.prototype.revert = function(snapshot_id) {
  // Convert from hex.
  snapshot_id = utils.bufferToInt(snapshot_id);

  this.logger.log("Reverting to snapshot #" + snapshot_id);

  if (snapshot_id > this.snapshots.length) {
    return false;
  }

  // Convert to zero based.
  snapshot_id = snapshot_id - 1;

  var snapshot = this.snapshots[snapshot_id];

  // Revert to previous state.
  while (this.snapshots.length > snapshot_id) {
    var snapshot = this.snapshots.pop();
    this.stateTrie.root = snapshot.root;
    this.vm.stateManager.revert(function() {});

    this.blockchain.revert(snapshot.blockNumber + 1);
  }

  return true;
};

StateManager.prototype.hasContractCode = function(address, callback) {
  this.vm.stateManager.getContractCode( address, function( err, result ) {
    if( err != null ) {
      callback( err, false );
    } else {
      callback( null, true );
    }
  });
}

module.exports = StateManager;