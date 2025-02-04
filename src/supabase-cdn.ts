import * as apigw from '@aws-cdk/aws-apigatewayv2-alpha';
import { HttpLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import * as cdk from 'aws-cdk-lib';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import { LoadBalancerV2Origin, HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { WebAcl } from './aws-waf-for-cloudfront';

interface SupabaseCdnProps {
  origin: string|elb.ILoadBalancerV2;
}

interface BehaviorProps {
  pathPattern: string;
  origin: string|elb.ILoadBalancerV2;
}

export class SupabaseCdn extends Construct {
  distribution: cf.Distribution;
  defaultBehaviorOptions: cf.AddBehaviorOptions;
  cfnParameters: {
    webAclArn: cdk.CfnParameter;
  };

  /** Construct for CloudFront and WAF */
  constructor(scope: Construct, id: string, props: SupabaseCdnProps) {
    super(scope, id);

    const origin = (typeof props.origin == 'string')
      ? new HttpOrigin(props.origin, { protocolPolicy: cf.OriginProtocolPolicy.HTTPS_ONLY })
      : new LoadBalancerV2Origin(props.origin, { protocolPolicy: cf.OriginProtocolPolicy.HTTP_ONLY });

    this.cfnParameters = {
      webAclArn: new cdk.CfnParameter(this, 'WebAclArn', {
        description: 'Web ACL for CloudFront.',
        type: 'String',
        default: '',
        allowedPattern: '^arn:aws:wafv2:us-east-1:[0-9]{12}:global/webacl/[\\w-]+/[\\w]{8}-[\\w]{4}-[\\w]{4}-[\\w]{4}-[\\w]{12}$|',
      }),
    };

    const webAclUndefined = new cdk.CfnCondition(this, 'WebAclUndefined', { expression: cdk.Fn.conditionEquals(this.cfnParameters.webAclArn, '') });

    const webAcl = new WebAcl(this, 'WebAcl', { description: 'Supabase Standard WebAcl' });
    (webAcl.node.defaultChild as cdk.CfnStack).cfnOptions.condition = webAclUndefined;

    const webAclId = cdk.Fn.conditionIf(webAclUndefined.logicalId, webAcl.webAclArn, this.cfnParameters.webAclArn.valueAsString);

    const cachePolicy = new cf.CachePolicy(this, 'CachePolicy', {
      cachePolicyName: `${cdk.Aws.STACK_NAME}-CachePolicy-${cdk.Aws.REGION}`,
      comment: 'Policy for Supabase API',
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(600),
      defaultTtl: cdk.Duration.seconds(1),
      headerBehavior: cf.CacheHeaderBehavior.allowList('apikey', 'authorization', 'host'),
      queryStringBehavior: cf.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const responseHeadersPolicy = new cf.ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
      responseHeadersPolicyName: `${cdk.Aws.STACK_NAME}-ResponseHeadersPolicy-${cdk.Aws.REGION}`,
      comment: 'Policy for Supabase API',
      customHeadersBehavior: {
        customHeaders: [
          { header: 'server', value: 'cloudfront', override: true },
        ],
      },
    });

    this.defaultBehaviorOptions = {
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cf.AllowedMethods.ALLOW_ALL,
      cachePolicy,
      originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER,
      responseHeadersPolicy,
    };

    const publicContentBehavior: cf.BehaviorOptions = {
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cf.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
      originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER,
      responseHeadersPolicy,
      origin,
    };

    this.distribution = new cf.Distribution(this, 'Distribution', {
      webAclId: webAclId.toString(),
      httpVersion: cf.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      comment: `Supabase - CDN (${this.node.path}/Distribution)`,
      defaultBehavior: {
        ...this.defaultBehaviorOptions,
        origin,
      },
      additionalBehaviors: {
        'storage/v1/object/public/*': publicContentBehavior,
      },
      errorResponses: [
        { httpStatus: 500, ttl: cdk.Duration.seconds(10) },
        { httpStatus: 501, ttl: cdk.Duration.seconds(10) },
        { httpStatus: 502, ttl: cdk.Duration.seconds(10) },
        { httpStatus: 503, ttl: cdk.Duration.seconds(10) },
        { httpStatus: 504, ttl: cdk.Duration.seconds(10) },
      ],
    });

  }

  //addBehavior(props: BehaviorProps) {
  //  const origin = (typeof props.origin == 'string')
  //    ? new HttpOrigin(props.origin, { protocolPolicy: cf.OriginProtocolPolicy.HTTPS_ONLY })
  //    : new LoadBalancerV2Origin(props.origin, { protocolPolicy: cf.OriginProtocolPolicy.HTTP_ONLY });
  //  this.distribution.addBehavior(props.pathPattern, origin, this.defaultBehaviorOptions);
  //}

  addCacheManager() {
    return new CacheManager(this, 'CacheManager', { distribution: this.distribution });
  }
};

interface CacheManagerProps {
  distribution: cf.IDistribution;
}

class CacheManager extends Construct {
  url: string;

  constructor(scope: Construct, id: string, props: CacheManagerProps) {
    super(scope, id);

    const distribution = props.distribution;

    const queue = new sqs.Queue(this, 'Queue');

    const apiFunction = new NodejsFunction(this, 'ApiFunction', {
      description: `${this.node.path}/ApiFunction`,
      entry: './src/functions/cdn-cache-manager/api.ts',
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        QUEUE_URL: queue.queueUrl,
      },
      tracing: lambda.Tracing.ACTIVE,
    });
    queue.grantSendMessages(apiFunction);

    const queueConsumer = new NodejsFunction(this, 'QueueConsumer', {
      description: `${this.node.path}/QueueConsumer`,
      entry: './src/functions/cdn-cache-manager/queue-consumer.ts',
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        DISTRIBUTION_ID: distribution.distributionId,
      },
      initialPolicy: [
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [`arn:aws:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${distribution.distributionId}`],
        }),
      ],
      events: [
        new SqsEventSource(queue, { batchSize: 100, maxBatchingWindow: cdk.Duration.seconds(5) }),
      ],
      tracing: lambda.Tracing.ACTIVE,
    });

    const api = new apigw.HttpApi(this, 'Api', {
      apiName: this.node.path.replace(/\//g, '') + 'Api',
      defaultIntegration: new HttpLambdaIntegration('Function', apiFunction),
    });

    this.url = api.url!;
  }
}