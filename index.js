'use strict';
const assert = require('assert');
const _ = require('underscore');
const config = require('config');
const AWS = require('aws-sdk');
const codepipeline = new AWS.CodePipeline();

exports.handler = (event, context) => {
  console.log(JSON.stringify(event,null,2));
  console.log(JSON.stringify(context,null,2));
  const job = event['CodePipeline.job'];

  let userParams = parseUserParameters(job.data.actionConfiguration.configuration.UserParameters);

  getObject({job: job, userParams: userParams})
  .then(createFunction)
  .then(putJobSuccess.bind(null, job.id, context))
  .catch(putJobFailure.bind(null, job.id, context))
  .then(context.succeed);
};

// for cross-region lambda deploy, getting object from S3 instead of passing s3 bucket/key
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
        resolve(_.extend(params, {data: data.Body}));
      }
    });
  });
}

function parseUserParameters(userParamStr) {
  try {
    return JSON.parse(userParamStr);
  } catch (error) {
    console.log('Failed to parse userParams', error);
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

function putJobSuccess(jobId, context, params) {
  console.log('putJobSuccess called', jobId);
  return new Promise((resolve, reject) => {
    codepipeline.putJobSuccessResult({jobId: jobId}, (err, data) => {
      if(err) {
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
