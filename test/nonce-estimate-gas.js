'use strict';

var Web3 = require('web3');
var async = require('async');
var TestRPC = require("../index.js");
var assert = require('assert');
var _ = require('underscore');
var to = require("../lib/utils/to.js");

describe("estimateGas nonce error", function() {
  var web3 = new Web3(TestRPC.provider());
  var accounts;
  var goodBytecode;
    
  function compileSolidity(source) {
    return new Promise(function(accept, reject) {
      web3.eth.compile.solidity(source, function(err, result) {
        if (err) return reject(err);
        accept(result);
      });
    });
  };

  before("compile solidity code that causes an event", function() {
    return compileSolidity("pragma solidity ^0.4.2; contract Example { event Event(); function Example() { Event(); } }").then(function(result) {
      goodBytecode = "0x" + result.code;
    });
  });

  function createContractWithGasEstimateAndGetTransaction(from, data) {
    return new Promise(function(accept, reject) {
      web3.eth.estimateGas({ data }, (error, gas) => {
        if (error) return reject(error);

        web3.eth.sendTransaction({
          from: from,
          gas: gas,
          data: data
        }, function(error, tx) {
          if (error) return reject(error);

          // adding this magically fixes the nonce issue
          web3.eth.getTransaction(tx, (error) => {
            if (error) return reject(error);

            accept(tx);
          })
        });
      });
    })
  }

  function createContractWithGasEstimate(from, data) {
    return new Promise(function(accept, reject) {
      web3.eth.estimateGas({ data }, (error, gas) => {
        if (error) return reject(error);

        web3.eth.sendTransaction({
          from: from,
          gas: gas,
          data: data
        }, function(error, tx) {
          if (error) return reject(error);
          accept(tx);
        });
      });
    })
  }

  function createContract(from, data, gas) {
    return new Promise(function(accept, reject) {
      web3.eth.sendTransaction({
        from: from,
        gas: gas,
        data: data
      }, function(error, tx) {
        if (error) return reject(error);
        accept(tx);
      });
    })
  }

  function getTx(tx) {
    return new Promise(function(accept, reject) {
      web3.eth.getTransaction(tx, function(err, result) {
        if (err) return reject(err);
        accept(result);
      });
    });
  };

  function getReceipt(tx) {
    return new Promise(function(accept, reject) {
      web3.eth.getTransactionReceipt(tx, function(err, result) {
        if (err) return reject(err);
        accept(result);
      });
    });
  };

  function checkNoncesAndContractAddresses(txs) {
    return Promise.resolve()
      .then(() => Promise.all(_.map(txs, tx => getTx(tx))))
      .then(transactions => {
        var nonces = _.map(transactions, tx => tx.nonce);
        assert.deepEqual(nonces, _.uniq(nonces), 'all nonces addresses must be unique');
      })
      .then(() => Promise.all(_.map(txs, tx => getReceipt(tx))))
      .then(receipts => {
        var contractAddresses = _.map(receipts, receipt => receipt.contractAddress);
        assert.deepEqual(contractAddresses, _.uniq(contractAddresses), 'all contract addresses must be unique');
      });
  }

  before(function(done) {
    web3.eth.getAccounts(function(err, accs) {
      if (err) return done(err);
      accounts = accs;
      done();
    });
  });

  it("create contracts in parallel should succeed", function() {
    return Promise.resolve()
      .then(() => Promise.all([
        createContract(accounts[0], goodBytecode),
        createContract(accounts[0], goodBytecode)
      ]))
      .then(txs => checkNoncesAndContractAddresses(txs));
  });

  it("create contracts WITH estimating gas in parallel should succeed", function() {
    return Promise.resolve()
      .then(() => Promise.all([
        createContractWithGasEstimate(accounts[0], goodBytecode),
        createContractWithGasEstimate(accounts[0], goodBytecode)
      ]))
      .then(txs => checkNoncesAndContractAddresses(txs));
  });

  it("create contracts WITH estimating gas AND getting transaction in parallel should succeed", function() {
    return Promise.resolve()
      .then(() => Promise.all([
        createContractWithGasEstimateAndGetTransaction(accounts[0], goodBytecode),
        createContractWithGasEstimateAndGetTransaction(accounts[0], goodBytecode)
      ]))
      .then(txs => checkNoncesAndContractAddresses(txs));
  });

  it("create contracts in series should succeed", function() {
    var txs = [];

    return Promise.resolve()
      .then(() => createContract(accounts[0], goodBytecode, 1500000).then(tx => txs.push(tx)))
      .then(() => createContract(accounts[0], goodBytecode, 1500000).then(tx => txs.push(tx)))
      .then(() => checkNoncesAndContractAddresses(txs));
  });

  it("create contracts WITH estimating gas in series should succeed", function() {
    var txs = [];

    return Promise.resolve()
      .then(() => createContractWithGasEstimate(accounts[0], goodBytecode).then(tx => txs.push(tx)))
      .then(() => createContractWithGasEstimate(accounts[0], goodBytecode).then(tx => txs.push(tx)))
      .then(() => checkNoncesAndContractAddresses(txs));
  });

  it("create contracts WITH estimating gas AND getting transaction in series should succeed", function() {
    var txs = [];

    return Promise.resolve()
      .then(() => createContractWithGasEstimateAndGetTransaction(accounts[0], goodBytecode).then(tx => txs.push(tx)))
      .then(() => createContractWithGasEstimateAndGetTransaction(accounts[0], goodBytecode).then(tx => txs.push(tx)))
      .then(() => checkNoncesAndContractAddresses(txs));
  });
});