'use strict';
const assert = require('assert');
const _ = require('underscore');
const config = require('config');
const AWS = require('aws-sdk');
const codepipeline = new AWS.CodePipeline();

exports.handler = (event, context) => {
  return exports.deploy(event, context);
};

exports.deploy = (event, context) => {
  console.log(JSON.stringify(event, null, 2));
  console.log(JSON.stringify(context, null, 2));

  let params = initParams(event);
  let jobId = params.job.id;

  getObject(params)
  .then(createFunction)
  .then(putArtifact)
  .then(putJobSuccess.bind(null, jobId, context))
  .catch(putJobFailure.bind(null, jobId, context))
  .then(context.succeed);
}

exports.promote = (event, context) => {
  console.log(JSON.stringify(event, null, 2));
  console.log(JSON.stringify(context, null, 2));

  let params = initParams(event);
  let jobId = params.job.id;

  getObject(params)
  .then(promoteLambdaVersion)
  .then(putJobSuccess.bind(null, jobId, context))
  .catch(putJobFailure.bind(null, jobId, context))
  .then(context.succeed);
}

function initParams(event) {
  const job = event['CodePipeline.job'];
  const s3Location = job.data.inputArtifacts[0].location.s3Location;
  const s3 = new AWS.S3({
    credentials: new AWS.Credentials(job.data.artifactCredentials),
    signatureVersion: 'v4'
  });
  const userParams = parseUserParameters(job.data.actionConfiguration.configuration.UserParameters);

  let params = {
    job: job,
    s3Location: s3Location,
    s3: s3,
    userParams: userParams
  }

  return params;
}

// for cross-region lambda deployment, getting object from S3 instead of passing s3 bucket/key
function getObject(params) {
  // currently, accept only one input.
  let s3Location = params.job.data.inputArtifacts[0].location.s3Location;
  let credentials = params.job.data.artifactCredentials;

  const s3 = new AWS.S3({
    credentials: new AWS.Credentials(credentials),
    signatureVersion: 'v4'
  });
  return new Promise((resolve, reject) => {
    let s3Params = {
      Bucket: s3Location.bucketName,
      Key: s3Location.objectKey
    }
    console.log(`fetching from S3: s3://${s3Params.Bucket}/${s3Params.Key}`);
    s3.getObject(s3Params, (err, data) => {
      if (err) {
        console.log('getObject failed', err);
        reject(new Error(err));
      } else {
        resolve(_.extend(params, {data: data.Body, s3: s3}));
      }
    });
  });
}


function promoteLambdaVersion(params) {
  let updateAliasParams = {}
  let alias;
  let region;
  let functionArn;

  try {
    const versionInfo = JSON.parse(params.data.toString());
    const qualifiedArn = versionInfo.FunctionArn;
    const version = versionInfo.Version;

    console.log('promoteLambdaVersion called', versionInfo, versionInfo.FunctionArn);

    let match = qualifiedArn.match(/^(arn:aws:lambda:([\w\d-]+):.+):(?:\$LATEST|[\w\d-_]+)$/);

    if (!match) {
      throw("functionArn invalid")
    }
    functionArn = match[1];
    region = match[2];

    if (_.has(params.userParams, 'alias')) {
      alias = params.userParams.alias
    } else {
      throw('alias is not declared in userParams');
    }
    updateAliasParams = {
      FunctionName: functionArn,
      Name: alias,
      FunctionVersion: version
    };
  }
  catch (err) {
    console.log('failed to parse inputArtifact', err)
    throw(new Error(err));
  }

  return new Promise((resolve, reject) => {
    console.log(`promoting ${updateAliasParams.FunctionName} to ${updateAliasParams.Name}`);
    const lambda = new AWS.Lambda({region: region});
    lambda.updateAlias(updateAliasParams, (err, data) => {
      if (!err) {
        console.log('updateAlias completed', data);
        resolve(_.extend(params, {data: data}));
      } else if (err.code === 'ResourceNotFoundException') {
        console.log('ResourceNotFoundException was returned. trying to createAlias');
        lambda.createAlias(updateAliasParams, (err, data) => {
          if (err) {
            console.log('createAlias failed', err);
            reject(new Error(err));
          }
          resolve(_.extend(params, {data: data}));
        })
      } else {
        console.log('updateAlias failed', err);
        reject(new Error(err));
      }
    })
  });
}

function parseUserParameters(userParamStr) {
  try {
    return JSON.parse(userParamStr);
  } catch (err) {
    console.log('Failed to parse userParams', err);
    return {}
  }
}

function createFunction(params) {
  const lambda = new AWS.Lambda({
    //credentials: new AWS.Credentials(job.data.artifactCredentials),
    region: params.userParams.Region || config.Region
  });

  let createParams = {
    Code: {
      ZipFile: params.data
    },
    Description: null,
    FunctionName: null,
    Handler: config.Handler,
    MemorySize: config.MemorySize,
    Publish: true,
    Role: null,
    Runtime: config.Runtime,
    Timeout: config.Timeout,
    VpcConfig: null,
  }
  // update using userParams
  createParams = _.extend(createParams, _.pick(params.userParams, _.keys(createParams)));
  createParams = _.omit(createParams, (v) => !v);
  console.log(createParams);

  createParams = _.chain(createParams)
  .extend(_.pick(params.userParams, _.keys(createParams)))
  .omit(createParams, (v) => !v)
  .value()
  console.log(createParams);

  let updateParams = {
    FunctionName: createParams.FunctionName,
    Publish: true,
    ZipFile: params.data
  };

  return new Promise((resolve, reject) => {
    lambda.createFunction(createParams, (err, data) => {
      if (!err) {
        resolve(_.extend(params, {data: data}));
      } else if (err.code == 'ResourceConflictException') {
        // call update function
        console.log('createFunction returns ResourceConflictException, trying to update');
        lambda.updateFunctionCode(updateParams, (err, data) => {
          if (err) {
            console.log('updateFunctionCode failed', err);
            reject(new Error(err));
          } else {
            // TODO: update configuration if exist configuration is different
            resolve(_.extend(params, {data: data}));
          }
        });
      } else {
        console.log('createFunction failed', err);
        reject(new Error(err));
      }
    });
  });
}

function putArtifact(params) {
  console.log('putArtifact called', params.data);
  console.log('putArtifact called', params.job);
  const s3Location = params.job.data.outputArtifacts[0].location.s3Location;
  const s3 = params.s3;
  let s3Params = {
    Bucket: s3Location.bucketName,
    Key: s3Location.objectKey,
    Body: JSON.stringify(params.data),
    ServerSideEncryption: 'aws:kms'
  }

  return new Promise((resolve, reject) => {
    console.log(`putting object to s3://${s3Params.Bucket}/${s3Params.Key}`);
    s3.putObject(s3Params, (err, data) => {
      if (err) {
        console.log('putObject failed', err);
        reject(new Error(err));
      } else {
        console.log('putObject succeed', data);
        resolve(params);
      }
    });
  });
}

function putJobSuccess(jobId, context, params) {
  console.log('putJobSuccess called', jobId);
  return new Promise((resolve, reject) => {
    codepipeline.putJobSuccessResult({jobId: jobId}, (err, data) => {
      if (err) {
        console.log('putJobSuccess failed', err);
        reject(new Error(err));
      } else {
        resolve(data);
      }
    });
  });
};

function putJobFailure(jobId, context, err) {
  console.log('putJobFailure', err);
  let failureParams = {
    jobId: jobId,
    failureDetails: {
      message: JSON.stringify(err),
      type: 'JobFailed',
      externalExecutionId: context.invokeid
    }
  };
  codepipeline.putJobFailureResult(failureParams, (err, data) => {
    context.fail(err);
  });
};
